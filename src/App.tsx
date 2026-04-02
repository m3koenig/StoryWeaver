/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  updateDoc, 
  onSnapshot, 
  query, 
  where, 
  getDoc,
  serverTimestamp,
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Plus, 
  Play, 
  Send, 
  Loader2, 
  LogOut, 
  BookOpen, 
  ShieldAlert,
  ArrowRight,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error?.message || "");
        if (parsed.error) errorMessage = parsed.error;
      } catch {
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <Card className="max-w-md w-full text-center space-y-4 border-rose-200 bg-rose-50/50">
            <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto" />
            <h2 className="text-2xl font-bold text-slate-900">Oops! An error occurred</h2>
            <p className="text-slate-600">{errorMessage}</p>
            <Button onClick={() => window.location.reload()} variant="danger" className="w-full">
              Reload Application
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Types ---
type GameStatus = 'lobby' | 'obstacle' | 'fact1' | 'fact2' | 'reveal';

interface Player {
  name: string;
  isHost: boolean;
  isReady?: boolean;
}

interface Game {
  id: string;
  status: GameStatus;
  players: Record<string, Player>;
  playerOrder: string[];
  createdAt: any;
  submissions: Record<string, boolean>;
}

interface Story {
  id: string;
  gameId: string;
  creatorId: string;
  obstacle: string;
  fact1?: string;
  fact1AuthorId?: string;
  fact2?: string;
  fact2AuthorId?: string;
  assignedTo?: string;
}

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  className, 
  disabled, 
  variant = 'primary',
  isLoading = false
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  className?: string; 
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  isLoading?: boolean;
}) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-400',
    secondary: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-400',
    outline: 'border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50 disabled:border-indigo-300 disabled:text-indigo-300',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-400'
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || isLoading}
      className={cn(
        'px-6 py-3 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 active:scale-95 disabled:cursor-not-allowed',
        variants[variant],
        className
      )}
    >
      {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : children}
    </button>
  );
};

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('bg-white/80 backdrop-blur-md rounded-3xl p-8 shadow-xl border border-white/20', className)}>
    {children}
  </div>
);

export default function App() {
  return (
    <ErrorBoundary>
      <GameApp />
    </ErrorBoundary>
  );
}

function GameApp() {
  const [user, setUser] = useState<User | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [gameCode, setGameCode] = useState('');

  // --- Connection Test ---
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();
  }, []);

  // --- Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const login = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
      setError('Failed to login with Google');
    }
  };

  const logout = () => auth.signOut();

  // --- Game Logic ---
  const createGame = async () => {
    if (!user) return;
    setLoading(true);
    const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const path = `games/${gameId}`;
    try {
      const gameRef = doc(db, 'games', gameId);
      const newGame: Partial<Game> = {
        status: 'lobby',
        players: {
          [user.uid]: { name: user.displayName || 'Anonymous', isHost: true }
        },
        playerOrder: [user.uid],
        createdAt: serverTimestamp(),
        submissions: {}
      };
      await setDoc(gameRef, newGame);
      subscribeToGame(gameId);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (code: string) => {
    if (!user || !code) return;
    setLoading(true);
    const gameId = code.toUpperCase();
    const path = `games/${gameId}`;
    try {
      const gameRef = doc(db, 'games', gameId);
      const gameSnap = await getDoc(gameRef);
      
      if (!gameSnap.exists()) {
        setError('Game not found');
        return;
      }

      const gameData = gameSnap.data() as Game;
      if (gameData.status !== 'lobby') {
        setError('Game already started');
        return;
      }

      const updatedPlayers = {
        ...gameData.players,
        [user.uid]: { name: user.displayName || 'Anonymous', isHost: false }
      };

      await updateDoc(gameRef, { 
        players: updatedPlayers,
        playerOrder: [...gameData.playerOrder, user.uid]
      });
      subscribeToGame(gameId);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    } finally {
      setLoading(false);
    }
  };

  const subscribeToGame = useCallback((gameId: string) => {
    const gameRef = doc(db, 'games', gameId);
    const unsubGame = onSnapshot(gameRef, (snap) => {
      if (snap.exists()) {
        setGame({ id: snap.id, ...snap.data() } as Game);
      } else {
        setGame(null);
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `games/${gameId}`));

    const storiesQuery = query(collection(db, 'stories'), where('gameId', '==', gameId));
    const unsubStories = onSnapshot(storiesQuery, (snap) => {
      setStories(snap.docs.map(d => ({ id: d.id, ...d.data() } as Story)));
    }, (err) => handleFirestoreError(err, OperationType.GET, 'stories'));

    return () => {
      unsubGame();
      unsubStories();
    };
  }, []);

  const startGame = async () => {
    if (!game || !user) return;
    const path = `games/${game.id}`;
    try {
      const gameRef = doc(db, 'games', game.id);
      await updateDoc(gameRef, { status: 'obstacle', submissions: {} });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const submitObstacle = async () => {
    if (!game || !user || !inputValue) return;
    try {
      const storyRef = doc(collection(db, 'stories'));
      await setDoc(storyRef, {
        gameId: game.id,
        creatorId: user.uid,
        obstacle: inputValue,
        assignedTo: user.uid // Initially assigned to creator
      });

      const gameRef = doc(db, 'games', game.id);
      await updateDoc(gameRef, {
        [`submissions.${user.uid}`]: true
      });
      setInputValue('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'stories/games');
    }
  };

  const submitFact = async (phase: 'fact1' | 'fact2') => {
    if (!game || !user || !inputValue) return;
    try {
      const myStory = stories.find(s => s.assignedTo === user.uid);
      if (!myStory) return;

      const storyRef = doc(db, 'stories', myStory.id);
      const updates: any = {};
      if (phase === 'fact1') {
        updates.fact1 = inputValue;
        updates.fact1AuthorId = user.uid;
      } else {
        updates.fact2 = inputValue;
        updates.fact2AuthorId = user.uid;
      }

      await updateDoc(storyRef, updates);

      const gameRef = doc(db, 'games', game.id);
      await updateDoc(gameRef, {
        [`submissions.${user.uid}`]: true
      });
      setInputValue('');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'stories/games');
    }
  };

  const nextPhase = async () => {
    if (!game || !user) return;
    const gameRef = doc(db, 'games', game.id);
    const currentStatus = game.status;
    let nextStatus: GameStatus = 'lobby';

    if (currentStatus === 'obstacle') nextStatus = 'fact1';
    else if (currentStatus === 'fact1') nextStatus = 'fact2';
    else if (currentStatus === 'fact2') nextStatus = 'reveal';

    try {
      const batch = writeBatch(db);
      
      // Shuffle assignments
      const n = game.playerOrder.length;
      const shift = nextStatus === 'fact1' ? 1 : 2;

      stories.forEach(story => {
        const creatorIndex = game.playerOrder.indexOf(story.creatorId);
        const assignedIndex = (creatorIndex + shift) % n;
        const assignedTo = game.playerOrder[assignedIndex];
        batch.update(doc(db, 'stories', story.id), { assignedTo });
      });

      batch.update(gameRef, { 
        status: nextStatus,
        submissions: {} 
      });

      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'batch/nextPhase');
    }
  };

  const resetGame = async () => {
    if (!game) return;
    try {
      const batch = writeBatch(db);
      stories.forEach(s => batch.delete(doc(db, 'stories', s.id)));
      batch.update(doc(db, 'games', game.id), { 
        status: 'lobby', 
        submissions: {},
        playerOrder: Object.keys(game.players)
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'batch/reset');
    }
  };

  // --- Render Helpers ---

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-indigo-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full"
        >
          <Card className="text-center space-y-6">
            <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto">
              <BookOpen className="w-10 h-10 text-indigo-600" />
            </div>
            <h1 className="text-4xl font-bold text-slate-900 tracking-tight">Story Weaver</h1>
            <p className="text-slate-600 text-lg">
              A collaborative storytelling game where obstacles meet unexpected facts.
            </p>
            <Button onClick={login} className="w-full py-4 text-lg">
              Sign in with Google
            </Button>
          </Card>
        </motion.div>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-900">Welcome, {user.displayName?.split(' ')[0]}</h2>
            <button onClick={logout} className="text-slate-400 hover:text-rose-500 transition-colors">
              <LogOut className="w-6 h-6" />
            </button>
          </div>
          
          <Card className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-500 uppercase tracking-wider">Join a Game</label>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  placeholder="Enter Code" 
                  value={gameCode}
                  onChange={(e) => setGameCode(e.target.value.toUpperCase())}
                  className="flex-1 bg-slate-100 border-none rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <Button onClick={() => joinGame(gameCode)} variant="secondary">Join</Button>
              </div>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-200"></span></div>
              <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-slate-400">Or</span></div>
            </div>

            <Button onClick={createGame} className="w-full py-4" variant="outline">
              <Plus className="w-5 h-5" /> Create New Game
            </Button>
          </Card>

          {error && (
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              className="bg-rose-50 border border-rose-200 text-rose-600 p-4 rounded-xl flex items-center gap-3"
            >
              <ShieldAlert className="w-5 h-5" />
              <p className="text-sm font-medium">{error}</p>
              <button onClick={() => setError(null)} className="ml-auto text-rose-400 hover:text-rose-600">×</button>
            </motion.div>
          )}
        </div>
      </div>
    );
  }

  const isHost = game.players[user.uid]?.isHost;
  const submissionCount = Object.keys(game.submissions).length;
  const playerCount = Object.keys(game.players).length;
  const everyoneSubmitted = submissionCount === playerCount;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center gap-4">
            <div className="bg-indigo-100 p-2 rounded-lg">
              <Users className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Game: {game.id}</h3>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-widest">{game.status}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {isHost && game.status === 'reveal' && (
              <Button onClick={resetGame} variant="outline" className="py-2 px-4 text-sm">Reset</Button>
            )}
            <Button onClick={() => setGame(null)} variant="danger" className="py-2 px-4 text-sm">Leave</Button>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {game.status === 'lobby' && (
            <motion.div 
              key="lobby"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
            >
              <Card className="space-y-8">
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold text-slate-900">Waiting for Players</h2>
                  <p className="text-slate-500">Share the code <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{game.id}</span> with your friends.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {(Object.entries(game.players) as [string, Player][]).map(([uid, p]) => (
                    <div key={uid} className="flex items-center gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-10 h-10 bg-indigo-500 rounded-full flex items-center justify-center text-white font-bold">
                        {p.name[0]}
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-slate-900">{p.name} {uid === user.uid && '(You)'}</p>
                        {p.isHost && <span className="text-[10px] bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full font-bold uppercase">Host</span>}
                      </div>
                    </div>
                  ))}
                </div>

                {isHost && (
                  <Button 
                    onClick={startGame} 
                    className="w-full py-4 text-lg" 
                    disabled={playerCount < 2}
                  >
                    <Play className="w-5 h-5" /> Start Storytelling
                  </Button>
                )}
                {!isHost && (
                  <div className="text-center p-4 bg-indigo-50 rounded-2xl text-indigo-600 font-medium animate-pulse">
                    Waiting for host to start...
                  </div>
                )}
              </Card>
            </motion.div>
          )}

          {(game.status === 'obstacle' || game.status === 'fact1' || game.status === 'fact2') && (
            <motion.div 
              key="gameplay"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <Card className="space-y-8">
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-bold text-slate-900">
                    {game.status === 'obstacle' ? 'Create an Obstacle' : 'Add a Fact'}
                  </h2>
                  <div className="flex items-center gap-2 text-slate-500 font-medium">
                    <CheckCircle2 className={cn("w-5 h-5", everyoneSubmitted ? "text-emerald-500" : "text-slate-300")} />
                    <span>{submissionCount}/{playerCount} Ready</span>
                  </div>
                </div>

                {game.submissions[user.uid] ? (
                  <div className="text-center py-12 space-y-4">
                    <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                    </div>
                    <h3 className="text-xl font-bold text-slate-900">Submission Received!</h3>
                    <p className="text-slate-500">Waiting for other players to finish their parts...</p>
                    {isHost && everyoneSubmitted && (
                      <Button onClick={nextPhase} className="mt-8 mx-auto">
                        Next Phase <ArrowRight className="w-5 h-5" />
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {game.status !== 'obstacle' && (
                      <div className="p-6 bg-indigo-50 rounded-2xl border border-indigo-100 space-y-4">
                        <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest">The Story So Far</p>
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-indigo-600">The Obstacle:</p>
                            <p className="text-lg text-slate-800 italic">"{stories.find(s => s.assignedTo === user.uid)?.obstacle}"</p>
                          </div>
                          {game.status === 'fact2' && (
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-emerald-600">The First Fact:</p>
                              <p className="text-lg text-slate-800 italic">"{stories.find(s => s.assignedTo === user.uid)?.fact1}"</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-500 uppercase tracking-wider">
                        {game.status === 'obstacle' ? 'What challenge does our hero face?' : 'What interesting detail can you add?'}
                      </label>
                      <textarea 
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder={game.status === 'obstacle' ? "e.g. A dragon that only breathes bubbles..." : "e.g. The bubbles are actually made of solid glass..."}
                        className="w-full h-32 bg-slate-50 border-2 border-slate-100 rounded-2xl p-4 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all resize-none text-lg"
                      />
                    </div>

                    <Button 
                      onClick={() => game.status === 'obstacle' ? submitObstacle() : submitFact(game.status as any)} 
                      className="w-full py-4"
                      disabled={!inputValue.trim()}
                    >
                      <Send className="w-5 h-5" /> Submit Part
                    </Button>
                  </div>
                )}
              </Card>
            </motion.div>
          )}

          {game.status === 'reveal' && (
            <motion.div 
              key="reveal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              <div className="text-center space-y-2 mb-8">
                <h2 className="text-4xl font-black text-slate-900 italic tracking-tight">The Tales We Wove</h2>
                <p className="text-slate-500 font-medium">Collaboratively crafted by {playerCount} storytellers</p>
              </div>

              <div className="grid grid-cols-1 gap-8">
                {stories.map((story, idx) => (
                  <motion.div
                    key={story.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.1 }}
                  >
                    <Card className="relative overflow-hidden border-none bg-white shadow-2xl">
                      <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500"></div>
                      <div className="space-y-8">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-indigo-600">
                            <span className="text-[10px] font-black uppercase tracking-[0.2em]">The Obstacle</span>
                            <div className="flex-1 h-px bg-indigo-100"></div>
                          </div>
                          <p className="text-2xl font-serif italic text-slate-900 leading-relaxed">
                            {story.obstacle}
                          </p>
                          <p className="text-[10px] text-slate-400 font-bold uppercase">By {game.players[story.creatorId]?.name}</p>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-emerald-600">
                            <span className="text-[10px] font-black uppercase tracking-[0.2em]">The Twist</span>
                            <div className="flex-1 h-px bg-emerald-100"></div>
                          </div>
                          <p className="text-xl font-serif italic text-slate-800 leading-relaxed">
                            {story.fact1}
                          </p>
                          <p className="text-[10px] text-slate-400 font-bold uppercase">By {game.players[story.fact1AuthorId!]?.name}</p>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-amber-600">
                            <span className="text-[10px] font-black uppercase tracking-[0.2em]">The Final Fact</span>
                            <div className="flex-1 h-px bg-amber-100"></div>
                          </div>
                          <p className="text-xl font-serif italic text-slate-800 leading-relaxed">
                            {story.fact2}
                          </p>
                          <p className="text-[10px] text-slate-400 font-bold uppercase">By {game.players[story.fact2AuthorId!]?.name}</p>
                        </div>
                      </div>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
