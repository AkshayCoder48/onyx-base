'use client'

import { useState, useSyncExternalStore } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Terminal,
  KeyRound,
  ArrowRight,
  Loader2,
  ShieldCheck,
  Zap,
  HardDrive,
  User,
  Mail,
  Copy,
  Check,
  Sparkles,
  Lock,
  LifeBuoy,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { useOnyxBase, type SessionUser } from '@/lib/store'
import { emailValidationError } from '@/lib/validate'
import { toast } from 'sonner'

interface SignupResult {
  userId: string
  apiKey: string
  name: string | null
  email: string | null
  createdAt: string
}

interface LoginResult {
  userId: string
  apiKey: string
  apiKeyName: string
  name: string | null
  email: string | null
  plan: string
  createdAt: string
  counts: SessionUser['counts']
  message?: string
}

/**
 * Returns window.location.origin on the client (empty string during SSR).
 * Uses useSyncExternalStore so the server and client render the same value
 * on the first pass (no hydration mismatch), then the client snaps to the
 * real origin immediately after hydration.
 */
function useOrigin() {
  return useSyncExternalStore(
    () => () => {}, // no subscription; the origin never changes during a session
    () => (typeof window !== 'undefined' ? window.location.origin : ''),
    () => '', // server snapshot
  )
}

export function LoginScreen() {
  const setSession = useOnyxBase((s) => s.setSession)
  const origin = useOrigin()
  const serverUrl = origin || 'https://your-onyx.example.com'

  // ── Sign-up state ──
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [signingUp, setSigningUp] = useState(false)
  const [created, setCreated] = useState<SignupResult | null>(null)

  // ── Sign-in state ──
  // Two sign-in modes: 'key' (paste an API key) and 'email' (email + password
  // recovery — used when the API key has been lost).
  const [signInMode, setSignInMode] = useState<'key' | 'email'>('key')
  const [signInKey, setSignInKey] = useState('')
  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [showSignInKey, setShowSignInKey] = useState(false)
  const [showSignInPassword, setShowSignInPassword] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [tab, setTab] = useState<'signup' | 'signin'>('signup')

  // ── Recovery state (restore keys from a Telegram backup paste) ──
  const [showRecover, setShowRecover] = useState(false)
  const [recoverPayload, setRecoverPayload] = useState('')
  const [recovering, setRecovering] = useState(false)

  // Live email validation — re-runs as the user types after they first blur.
  const emailError = emailTouched ? emailValidationError(email) : ''
  const emailValid = !emailError && email.length > 0
  const passwordError = passwordTouched
    ? password.length < 6
      ? 'Password must be at least 6 characters.'
      : ''
    : ''
  const passwordValid = !passwordError && password.length > 0
  const canSubmit = name.trim().length > 0 && emailValid && passwordValid

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    setEmailTouched(true)
    setPasswordTouched(true)
    if (!name.trim()) return toast.error('Please enter your name')
    const err = emailValidationError(email)
    if (err) return toast.error(err)
    if (password.length < 6) return toast.error('Password must be at least 6 characters')
    setSigningUp(true)
    try {
      const res = await api<SignupResult>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          source: 'web',
        }),
      })
      setCreated(res)
      toast.success('Account created — copy your API key below')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-up failed'
      toast.error(msg)
      // If the email is already registered, jump to the Sign in tab so the
      // user can sign in with their API key or email + password.
      if (/already exists/i.test(msg)) {
        setTab('signin')
        setSignInMode('email')
      }
    } finally {
      setSigningUp(false)
    }
  }

  function enterDashboard(key: string, partial: Partial<SessionUser>) {
    // Re-verify on the way in so we get accurate counts.
    api<{ userId: string; name: string | null; plan: string; apiKeyName: string; createdAt: string; counts: SessionUser['counts']; isAdmin?: boolean }>(
      '/api/auth/verify',
      { method: 'POST', body: JSON.stringify({ apiKey: key }) },
    )
      .then((res) => {
        setSession(key, {
          userId: res.userId,
          name: res.name,
          plan: res.plan,
          apiKeyName: res.apiKeyName,
          createdAt: res.createdAt,
          counts: res.counts ?? partial.counts ?? { records: 0, collections: 0, apiKeys: 0, logs: 0 },
          isAdmin: res.isAdmin,
        })
        toast.success(`Welcome, ${res.userId}`)
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Could not verify API key')
      })
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    const key = signInKey.trim()
    if (!key) return toast.error('Paste your API key first')
    setSigningIn(true)
    try {
      const res = await api<{ userId: string; name: string | null; plan: string; apiKeyName: string; createdAt: string; counts: SessionUser['counts']; isAdmin?: boolean }>(
        '/api/auth/verify',
        { method: 'POST', body: JSON.stringify({ apiKey: key }) },
      )
      setSession(key, {
        userId: res.userId,
        name: res.name,
        plan: res.plan,
        apiKeyName: res.apiKeyName,
        createdAt: res.createdAt,
        counts: res.counts,
        isAdmin: res.isAdmin,
      })
      toast.success(`Welcome back, ${res.userId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSigningIn(false)
    }
  }

  /**
   * Email + password recovery sign-in. Used when the API key has been lost.
   * The server verifies the credentials and returns a working API key (the
   * most recent non-revoked one for the account), which we then use to enter
   * the dashboard — exactly as if the user had pasted the key themselves.
   */
  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault()
    const emailVal = signInEmail.trim()
    const pw = signInPassword
    if (!emailVal) return toast.error('Enter your email')
    if (!pw) return toast.error('Enter your password')
    setSigningIn(true)
    try {
      const res = await api<LoginResult>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: emailVal.toLowerCase(), password: pw }),
      })
      setSession(res.apiKey, {
        userId: res.userId,
        name: res.name,
        plan: res.plan,
        apiKeyName: res.apiKeyName,
        createdAt: res.createdAt,
        counts: res.counts,
      })
      toast.success(res.message || `Welcome back, ${res.userId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSigningIn(false)
    }
  }

  /**
   * Restore keys from a Telegram backup paste. The user opens their Telegram
   * chat, copies the pinned manifest message, and pastes it here. The server
   * re-inserts the users + keys into its local store so the user can sign in.
   */
  async function handleRecover() {
    const payload = recoverPayload.trim()
    if (!payload) return toast.error('Paste your Telegram backup manifest first')
    setRecovering(true)
    try {
      const res = await api<{ usersRestored: number; keysRestored: number; message: string }>(
        '/api/auth/recover',
        { method: 'POST', body: JSON.stringify({ payload }) },
      )
      toast.success(res.message)
      setRecoverPayload('')
      setShowRecover(false)
      // If keys were restored, prompt the user to paste one to sign in.
      if (res.keysRestored > 0) {
        toast.info('Keys restored — paste one in the API key field above to sign in.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Recovery failed')
    } finally {
      setRecovering(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1 grid lg:grid-cols-2">
        {/* Left — hero / marketing */}
        <section className="relative hidden lg:flex flex-col justify-between p-10 bg-grid overflow-hidden border-r border-border/60">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-2.5">
            <Logo />
            <span className="font-mono text-sm tracking-tight text-foreground/80">Onyx Base</span>
            <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary uppercase">
              beta
            </span>
          </div>

          <div className="relative space-y-6 max-w-md">
            <h1 className="text-4xl font-semibold tracking-tight leading-[1.1]">
              The key-value &amp; file store
              <br />
              that lives in{' '}
              <span className="text-primary">Telegram</span>.
            </h1>
            <p className="text-muted-foreground text-[15px] leading-relaxed">
              No database setup. Drop in a Bot Token + Chat ID and ship. Store
              key-values AND files up to 2 GB each — unlimited &amp; free for
              everyone. Sign up here to get your API key, then use it from the web
              dashboard, the CLI, or the REST API — every write is mirrored to a
              private Telegram channel as a durable backup.
            </p>
            <div className="space-y-2.5 pt-2">
              <Feature icon={<Zap className="size-4" />} text="Sign up here → get an API key in 5 seconds" />
              <Feature icon={<HardDrive className="size-4" />} text="Upload files up to 2 GB — any extension, unlimited count" />
              <Feature icon={<Terminal className="size-4" />} text="Connect the CLI with: onyx login --server <url> --key <your-key>" />
              <Feature icon={<ShieldCheck className="size-4" />} text="Same key works in the dashboard, CLI, and REST API" />
            </div>
          </div>

          <div className="relative font-mono text-xs text-muted-foreground/70">
            <span className="text-primary">$</span> sign up → copy key → use anywhere.
          </div>
        </section>

        {/* Right — auth form */}
        <section className="flex items-center justify-center p-6 sm:p-10">
          <div className="w-full max-w-sm">
            <div className="lg:hidden flex items-center gap-2.5 mb-7">
              <Logo />
              <span className="font-mono text-sm">Onyx Base</span>
            </div>

            <AnimatePresence mode="wait">
              {created ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.3 }}
                >
                  <SuccessPanel
                    result={created}
                    onEnter={() =>
                      enterDashboard(created.apiKey, {
                        userId: created.userId,
                        name: created.name,
                        plan: 'free',
                        apiKeyName: 'default',
                        createdAt: created.createdAt,
                        counts: { records: 0, collections: 0, apiKeys: 0, logs: 0 },
                      })
                    }
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="form"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-7"
                >
                  <div className="space-y-1.5">
                    <h2 className="text-xl font-semibold tracking-tight">Get started</h2>
                    <p className="text-sm text-muted-foreground">
                      Create a new account, or sign in if you already have an API key.
                    </p>
                  </div>

                  <Tabs value={tab} onValueChange={(v) => setTab(v as 'signup' | 'signin')} className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="signup" className="text-xs">
                        <Sparkles className="size-3.5 mr-1.5" /> Sign up
                      </TabsTrigger>
                      <TabsTrigger value="signin" className="text-xs">
                        <KeyRound className="size-3.5 mr-1.5" /> Sign in
                      </TabsTrigger>
                    </TabsList>

                    {/* ── Sign up ── */}
                    <TabsContent value="signup" className="mt-5">
                      <form onSubmit={handleSignUp} className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Name
                          </Label>
                          <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                            <Input
                              id="name"
                              type="text"
                              autoComplete="name"
                              placeholder="Ada Lovelace"
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              className="pl-9 h-11"
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="email" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Email
                          </Label>
                          <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                            <Input
                              id="email"
                              type="email"
                              autoComplete="email"
                              placeholder="ada@example.com"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              onBlur={() => setEmailTouched(true)}
                              aria-invalid={!!emailError}
                              className={`pl-9 h-11 ${emailError ? 'border-red-400/60 focus-visible:ring-red-400/30' : emailValid ? 'border-primary/40' : ''}`}
                            />
                          </div>
                          {emailError ? (
                            <p className="text-[11px] text-red-500 leading-relaxed">{emailError}</p>
                          ) : emailValid ? (
                            <p className="text-[11px] text-primary/80 leading-relaxed flex items-center gap-1">
                              <Check className="size-3" /> Looks good.
                            </p>
                          ) : (
                            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                              We validate the email — no throwaway addresses.
                            </p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="password" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Password
                          </Label>
                          <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                            <Input
                              id="password"
                              type={showPassword ? 'text' : 'password'}
                              autoComplete="new-password"
                              placeholder="At least 6 characters"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              onBlur={() => setPasswordTouched(true)}
                              aria-invalid={!!passwordError}
                              className={`pl-9 pr-16 h-11 ${passwordError ? 'border-red-400/60 focus-visible:ring-red-400/30' : passwordValid ? 'border-primary/40' : ''}`}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2 text-[11px] text-muted-foreground"
                              onClick={() => setShowPassword((v) => !v)}
                            >
                              {showPassword ? 'Hide' : 'Show'}
                            </Button>
                          </div>
                          {passwordError ? (
                            <p className="text-[11px] text-red-500 leading-relaxed">{passwordError}</p>
                          ) : passwordValid ? (
                            <p className="text-[11px] text-primary/80 leading-relaxed flex items-center gap-1">
                              <Check className="size-3" /> Saved to the Telegram cloud — recovers your key if you lose it.
                            </p>
                          ) : (
                            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                              Used <em>only</em> to recover your API key if you lose it. All data operations still use the API key.
                            </p>
                          )}
                        </div>
                        <Button
                          type="submit"
                          disabled={signingUp || !canSubmit}
                          className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
                        >
                          {signingUp ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <>Create account & get API key <ArrowRight className="size-4" /></>
                          )}
                        </Button>
                        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                          We create a developer account and generate your <code className="font-mono text-primary">kv_live_…</code> key
                          instantly. Your password is hashed (scrypt) and saved to the Telegram cloud so you can sign back in with email + password if you ever lose the key. Already have an account? Use the <strong>Sign in</strong> tab.
                        </p>
                      </form>
                    </TabsContent>

                    {/* ── Sign in ── */}
                    <TabsContent value="signin" className="mt-5">
                      {/* Mode toggle: API key  |  Email + password */}
                      <div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-lg border border-border/60 bg-card/40 text-xs">
                        <button
                          type="button"
                          onClick={() => setSignInMode('key')}
                          className={`flex items-center justify-center gap-1.5 h-8 rounded-md transition-colors ${signInMode === 'key' ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          <KeyRound className="size-3.5" /> API key
                        </button>
                        <button
                          type="button"
                          onClick={() => setSignInMode('email')}
                          className={`flex items-center justify-center gap-1.5 h-8 rounded-md transition-colors ${signInMode === 'email' ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          <Mail className="size-3.5" /> Email + password
                        </button>
                      </div>

                      {signInMode === 'key' ? (
                        <form onSubmit={handleSignIn} className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="key" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              API Key
                            </Label>
                            <div className="relative">
                              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                id="key"
                                type={showSignInKey ? 'text' : 'password'}
                                autoComplete="off"
                                placeholder="kv_live_xxxxxxxxx"
                                value={signInKey}
                                onChange={(e) => setSignInKey(e.target.value)}
                                className="pl-9 pr-16 font-mono text-sm h-11"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2 text-[11px] text-muted-foreground"
                                onClick={() => setShowSignInKey((v) => !v)}
                              >
                                {showSignInKey ? 'Hide' : 'Show'}
                              </Button>
                            </div>
                          </div>
                          <Button
                            type="submit"
                            disabled={signingIn}
                            className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
                          >
                            {signingIn ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <>Enter dashboard <ArrowRight className="size-4" /></>
                            )}
                          </Button>
                          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                            Paste the key you got from a previous sign-up or from{' '}
                            <code className="font-mono text-primary">onyx login</code> in the terminal.
                            Lost it? Switch to <strong>Email + password</strong> above, or open the recovery box below.
                          </p>
                        </form>
                      ) : (
                        <form onSubmit={handleEmailSignIn} className="space-y-4">
                          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-start gap-2">
                            <LifeBuoy className="size-3.5 text-primary mt-0.5 shrink-0" />
                            <p className="text-[11px] text-primary/80 leading-relaxed">
                              <strong>Key recovery login.</strong> Enter the email + password you signed up with
                              and we&apos;ll retrieve a working API key for your account.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="signin-email" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Email
                            </Label>
                            <div className="relative">
                              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                id="signin-email"
                                type="email"
                                autoComplete="email"
                                placeholder="ada@example.com"
                                value={signInEmail}
                                onChange={(e) => setSignInEmail(e.target.value)}
                                className="pl-9 h-11"
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="signin-password" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Password
                            </Label>
                            <div className="relative">
                              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                id="signin-password"
                                type={showSignInPassword ? 'text' : 'password'}
                                autoComplete="current-password"
                                placeholder="Your password"
                                value={signInPassword}
                                onChange={(e) => setSignInPassword(e.target.value)}
                                className="pl-9 pr-16 h-11"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2 text-[11px] text-muted-foreground"
                                onClick={() => setShowSignInPassword((v) => !v)}
                              >
                                {showSignInPassword ? 'Hide' : 'Show'}
                              </Button>
                            </div>
                          </div>
                          <Button
                            type="submit"
                            disabled={signingIn}
                            className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
                          >
                            {signingIn ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <>Recover key & sign in <ArrowRight className="size-4" /></>
                            )}
                          </Button>
                          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                            The password is the one you set during sign-up. We verify it against the hashed
                            copy saved in the Telegram cloud and hand back your most recent active API key —
                            no new key is created. All data operations still use the API key alone.
                          </p>
                        </form>
                      )}

                      {/* ── Recover from Telegram backup (manual paste) ── */}
                      <div className="pt-1 border-t border-border/40">
                        <button
                          type="button"
                          onClick={() => setShowRecover((v) => !v)}
                          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-primary transition-colors mt-3"
                        >
                          <LifeBuoy className="size-3.5" />
                          Lost your key? Recover from Telegram backup
                          {showRecover ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        </button>
                        {showRecover && (
                          <div className="mt-3 space-y-2.5">
                            <div className="rounded-md border border-amber-400/30 bg-amber-500/5 p-3 flex items-start gap-2">
                              <AlertTriangle className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
                              <p className="text-[11px] text-amber-700/90 dark:text-amber-300/80 leading-relaxed">
                                <strong>This only works if you set up a custom Telegram chat ID <em>and</em> bot token</strong>{' '}
                                in Settings. With only a chat ID (no bot token), or with the server default, your keys
                                are saved to the server-side Telegram which is <strong>not public to you</strong> — so
                                the key is lost forever <em>unless</em> you use the <strong>Email + password</strong> sign-in above.
                              </p>
                            </div>
                            <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                              When you have your own bot + chat configured, every key is automatically saved to YOUR
                              Telegram chat as a pinned <code className="font-mono text-primary">CLOUDKV_IDENTITY_MANIFEST</code> message.
                              Open that chat, copy the pinned message, and paste it below to restore your keys here.
                            </p>
                            <Textarea
                              value={recoverPayload}
                              onChange={(e) => setRecoverPayload(e.target.value)}
                              placeholder="Paste the CLOUDKV_IDENTITY_MANIFEST message from your Telegram chat here…"
                              className="font-mono text-[11px] min-h-[110px] max-h-[220px] resize-y"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={recovering || !recoverPayload.trim()}
                              onClick={handleRecover}
                              className="w-full"
                            >
                              {recovering ? (
                                <><Loader2 className="size-3.5 animate-spin" /> Restoring…</>
                              ) : (
                                <><LifeBuoy className="size-3.5" /> Restore keys</>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Terminal className="size-3.5" /> Prefer the terminal? Sign up there:
                    </div>
                    <pre className="font-mono text-[12px] leading-relaxed text-primary/90 overflow-x-auto">
{`$ onyx login \\
    --server ${serverUrl} \\
    --name "Your Name" \\
    --email you@example.com`}
                    </pre>
                    <p className="text-[11px] text-muted-foreground/70">
                      Or create the account here and connect the terminal with{' '}
                      <code className="font-mono text-primary">onyx login --server &lt;url&gt; --key &lt;api-key&gt;</code>.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Success panel — shown right after sign-up. Reveals the API key once and
// gives the user a one-click way to copy the CLI connect command.
// ─────────────────────────────────────────────────────────────────────────────

function SuccessPanel({
  result,
  onEnter,
}: {
  result: SignupResult
  onEnter: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const origin = useOrigin()
  const serverUrl = origin || 'https://your-onyx.example.com'

  const cliCommand = `onyx login --server ${serverUrl} --key ${result.apiKey}`

  async function copy(text: string, which: 'key' | 'cmd') {
    try {
      await navigator.clipboard.writeText(text)
      if (which === 'key') {
        setCopiedKey(true)
        setTimeout(() => setCopiedKey(false), 1500)
      } else {
        setCopiedCmd(true)
        setTimeout(() => setCopiedCmd(false), 1500)
      }
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Could not copy — select and copy manually')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <Check className="size-5 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Account created</h2>
          <p className="text-sm text-muted-foreground">
            Welcome, <span className="text-foreground">{result.name}</span>. Save this key —
            you&apos;ll need it to sign in here and to connect the CLI.
          </p>
        </div>
      </div>

      {/* Identity card */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <Row label="User ID" value={result.userId} mono accent="cyan" />
        {result.email && <Row label="Email" value={result.email} mono={false} />}
      </div>

      {/* API key reveal + copy */}
      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your API Key <span className="text-primary normal-case font-medium">(shown once — copy now)</span>
        </Label>
        <div className="relative">
          <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-primary" />
          <Input
            readOnly
            type={revealed ? 'text' : 'password'}
            value={result.apiKey}
            onFocus={(e) => e.currentTarget.select()}
            className="pl-9 pr-24 font-mono text-sm h-11 border-primary/30 bg-primary/5"
          />
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-[11px] text-muted-foreground"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? 'Hide' : 'Show'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-[11px]"
              onClick={() => copy(result.apiKey, 'key')}
            >
              {copiedKey ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* CLI connect command */}
      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Terminal className="size-3.5" /> Connect this account from your terminal
        </Label>
        <div className="relative rounded-lg border border-border/60 bg-stone-900">
          <pre className="font-mono text-[12px] leading-relaxed text-primary px-3 py-3 pr-12 overflow-x-auto whitespace-pre-wrap break-all">
            {`$ ${cliCommand}`}
          </pre>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2"
            onClick={() => copy(cliCommand, 'cmd')}
          >
            {copiedCmd ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          Run that in any terminal pointed at this server. You can create as many
          accounts as you like — each gets its own key, all manageable from the
          CLI and the dashboard.
        </p>
      </div>

      <Button
        type="button"
        onClick={onEnter}
        className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
      >
        Enter dashboard <ArrowRight className="size-4" />
      </Button>
    </div>
  )
}

function Row({
  label,
  value,
  mono = true,
  accent = 'primary',
}: {
  label: string
  value: string
  mono?: boolean
  accent?: 'primary' | 'cyan'
}) {
  const accentClass = accent === 'cyan' ? 'text-cyan-600' : 'text-primary'
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`${mono ? 'font-mono ' : ''}${accentClass} truncate`}>{value}</span>
    </div>
  )
}

function Logo() {
  return (
    <img src="/logo.png" alt="Onyx Base" className="size-8 rounded-lg object-cover" />
  )
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-foreground/80">
      <span className="size-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
        {icon}
      </span>
      {text}
    </div>
  )
}
