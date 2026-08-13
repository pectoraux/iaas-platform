"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import { formatDistanceToNow, format } from "date-fns"
import { toast, Toaster } from "sonner"
import {
  Network,
  RefreshCw,
  Play,
  Activity,
  ShieldCheck,
  Coins,
  CircleCheck,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  Boxes,
  Cpu,
  Server,
  Building2,
  User,
  FileJson,
  ArrowDownRight,
  ArrowUpRight,
  AlertTriangle,
  Lock,
  Cog,
  Layers,
  CircleDot,
  Receipt,
  Wallet,
  BookOpen,
  LayoutTemplate,
  CircuitBoard,
  PackageCheck,
  Banknote,
  ListChecks,
} from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { apiFetch, ApiError } from "@/lib/api-client"
import { cn } from "@/lib/utils"

// ===========================================================================
// Types — minimal mirrors of the backend response shapes.
// ===========================================================================

interface Tenant {
  id: string
  name: string
  slug: string
  status: string
  plan: string
  createdAt: string
}

interface Stats {
  tenants: number
  networks: number
  operators: number
  assets: number
  devices: number
  events_received: number
  events_verified: number
  events_rejected: number
  verification_success_rate: number
  attestations: number
  contributions: number
  rewards: number
  ledger_entries: number
  settlements: number
  settlements_completed: number
  settlements_failed: number
  total_reward_amount: number
  total_settled_amount: number
}

interface VerificationCheck {
  name: string
  status: string
  detail?: string
}

interface E2EResult {
  tenant: { id: string; slug: string }
  network: { id: string; slug: string; version_id: string }
  operator: { id: string }
  asset: { id: string }
  device: { id: string; provisioning_secret: string }
  event: { id: string; external_event_id: string; status: string }
  verification: {
    overall_status: string
    confidence: number
    checks: VerificationCheck[]
  }
  attestation: { id: string; quantity: number; unit: string }
  contribution: { id: string; quantity: number; unit: string }
  reward: { id: string; amount: number; currency: string }
  ledger: {
    reward_credit_entry_id: string
    platform_fee_entry_id: string
    balance_after: number
  }
  settlement: { id: string; status: string; provider_payout_id: string | null }
  chain: {
    event_id: string
    attestation_id: string
    contribution_id: string
    reward_id: string
    ledger_entry_id: string
    settlement_id: string
  }
}

interface Template {
  key: string
  name: string
  slug: string
  vertical: string
  description: string
  asset_types: string[]
  capabilities: Array<{ type: string; unit: string; schemaVersion: number; fields: Record<string, string> }>
  verification: { checks: string[]; numeric_ranges?: Record<string, { min?: number; max?: number }>; timestamp_window_seconds?: number }
  reward: { type: string; rate: string; unit: string; currency: string; platform_fee_pct?: number }
}

interface HealthStatus {
  status: string
  timestamp: string
  counts: Record<string, number>
}

type Entity = Record<string, unknown>

// ===========================================================================
// Constants
// ===========================================================================

const DEFAULT_PAYLOADS: Record<string, string> = {
  "generic-resource-network": JSON.stringify(
    { output_value: 4.8, duration_seconds: 3600 },
    null,
    2,
  ),
  "energy-vpp": JSON.stringify(
    { power_kw: 4.8, available_energy_kwh: 13.5, state_of_charge_pct: 72 },
    null,
    2,
  ),
}

const PIPELINE_STEPS = [
  { key: "events_received", label: "Event", icon: Activity },
  { key: "events_verified", label: "Verification", icon: ShieldCheck },
  { key: "attestations", label: "Attestation", icon: Check },
  { key: "contributions", label: "Contribution", icon: Boxes },
  { key: "rewards", label: "Reward", icon: Coins },
  { key: "ledger_entries", label: "Ledger", icon: BookOpen },
  { key: "settlements", label: "Settlement", icon: CircleCheck },
] as const

// ===========================================================================
// Helpers
// ===========================================================================

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function formatCurrency(n: number, currency = "USD"): string {
  if (currency === "USD") return currencyFmt.format(n)
  return `${n.toFixed(2)} ${currency}`
}

function truncateId(id: string | null | undefined, len = 12): string {
  if (!id) return "—"
  return id.length > len ? `${id.slice(0, len)}…` : id
}

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function asString(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return String(v)
}

// ---- status color tokens (emerald/amber/rose/teal/sky/muted — NO indigo/blue) ----

type Tone = "emerald" | "amber" | "rose" | "teal" | "sky" | "muted"

const TONE_CLASSES: Record<Tone, string> = {
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  amber: "bg-amber-100 text-amber-800 border-amber-200",
  rose: "bg-rose-100 text-rose-700 border-rose-200",
  teal: "bg-teal-100 text-teal-700 border-teal-200",
  sky: "bg-sky-100 text-sky-700 border-sky-200",
  muted: "bg-muted text-muted-foreground border-border",
}

const TONE_DOT: Record<Tone, string> = {
  emerald: "text-emerald-600",
  amber: "text-amber-600",
  rose: "text-rose-600",
  teal: "text-teal-600",
  sky: "text-sky-600",
  muted: "text-muted-foreground",
}

function toneForStatus(status: string): Tone {
  const s = status.toLowerCase()
  if (
    ["verified", "active", "completed", "settled", "published", "provisioned", "registered"].includes(s)
  )
    return "emerald"
  if (["submitted", "processing"].includes(s)) return "sky"
  if (["pending", "calculated", "created", "retrying", "draft"].includes(s)) return "amber"
  if (["rejected", "failed", "suspended", "revoked", "voided", "disputed", "offboarded"].includes(s))
    return "rose"
  if (["posted", "archived"].includes(s)) return "teal"
  return "muted"
}

function toneForAuditEvent(eventType: string): Tone {
  const e = eventType.toLowerCase()
  if (
    e.endsWith(".created") ||
    e.endsWith(".provisioned") ||
    e.endsWith(".received") ||
    e.endsWith(".instantiated")
  )
    return "emerald"
  if (
    e.endsWith(".completed") ||
    e.endsWith(".published") ||
    e.endsWith(".posted") ||
    e.endsWith(".activated")
  )
    return "teal"
  if (e.endsWith(".failed") || e.endsWith(".suspended") || e.endsWith(".rejected")) return "rose"
  return "muted"
}

// ===========================================================================
// Small presentational components
// ===========================================================================

function CopyableId({
  id,
  label,
  className,
}: {
  id: string | null | undefined
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      toast.success("Copied to clipboard", { description: label ?? truncateId(id) })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Could not copy to clipboard")
    }
  }, [id, label])

  if (!id) return <span className="text-muted-foreground">—</span>
  return (
    <button
      type="button"
      onClick={onCopy}
      title={id}
      className={cn(
        "group inline-flex max-w-full items-center gap-1 rounded font-mono text-xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <span className="truncate">{truncateId(id)}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
      <span className="sr-only">Copy {label ?? "id"}</span>
    </button>
  )
}

function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = toneForStatus(status)
  return (
    <Badge variant="outline" className={cn("capitalize", TONE_CLASSES[tone], className)}>
      {status}
    </Badge>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sublabel,
  sublabelTone = "muted",
  loading,
  delay = 0,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sublabel?: React.ReactNode
  sublabelTone?: Tone
  loading?: boolean
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: "easeOut" }}
    >
      <Card className="overflow-hidden py-4">
        <CardContent className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {label}
            </p>
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
            )}
            {sublabel && (
              <p
                className={cn(
                  "truncate text-xs",
                  sublabelTone === "muted" && "text-muted-foreground",
                  sublabelTone === "rose" && "text-rose-600",
                  sublabelTone === "emerald" && "text-emerald-600",
                  sublabelTone === "amber" && "text-amber-600",
                )}
              >
                {sublabel}
              </p>
            )}
          </div>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <Icon className="size-5" />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <PackageCheck className="size-5" />
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Failed to load</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

function RelativeTime({ date }: { date: string | Date | null | undefined }) {
  if (!date) return <span className="text-muted-foreground">—</span>
  const d = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(d.getTime())) {
    return <span className="text-muted-foreground tabular-nums">—</span>
  }
  // suppressHydrationWarning: the relative-time text is computed from Date.now()
  // and will legitimately differ between the server render and the client mount.
  return (
    <time
      dateTime={d.toISOString()}
      title={format(d, "PPpp")}
      className="text-muted-foreground tabular-nums"
      suppressHydrationWarning
    >
      {formatDistanceToNow(d, { addSuffix: true })}
    </time>
  )
}

// ===========================================================================
// Data hook
// ===========================================================================

function useApi<T>(
  path: string | null,
  tenantId: string | undefined,
  refreshKey: number,
): { data: T | null; loading: boolean; error: string | null } {
  const currentKey = `${path ?? ""}::${tenantId ?? ""}::${refreshKey}`
  const [state, setState] = useState<{
    data: T | null
    loading: boolean
    error: string | null
    key: string
  }>({ data: null, loading: false, error: null, key: "" })

  useEffect(() => {
    if (!path) return
    let cancelled = false
    // Defer the "loading" transition out of the effect body (avoids a synchronous
    // setState-in-effect). The request itself is fired immediately.
    queueMicrotask(() => {
      if (cancelled) return
      setState((s) => ({ data: s.data, loading: true, error: null, key: currentKey }))
    })
    apiFetch<T>(path, { tenantId })
      .then((d) => {
        if (cancelled) return
        setState({ data: d, loading: false, error: null, key: currentKey })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : "Unknown error",
          key: currentKey,
        })
      })
    return () => {
      cancelled = true
    }
  }, [currentKey, path, tenantId])

  // Loading when the requested key differs from the last-completed key.
  const loading = state.key !== currentKey || state.loading
  return { data: state.data, loading, error: state.error }
}

// ===========================================================================
// Pipeline tab (presentational — state lifted to Home)
// ===========================================================================

function PipelineTab({
  stats,
  templateKey,
  payload,
  running,
  result,
  onTemplateChange,
  onPayloadChange,
  onRunE2E,
}: {
  stats: Stats | null
  templateKey: string
  payload: string
  running: boolean
  result: E2EResult | null
  onTemplateChange: (key: string) => void
  onPayloadChange: (v: string) => void
  onRunE2E: () => void
}) {
  return (
    <div className="space-y-6">
      {/* Pipeline visualization */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CircuitBoard className="size-4 text-emerald-600" />
            Canonical Pipeline
          </CardTitle>
          <CardDescription>
            Event → Verification → Attestation → Contribution → Reward → Ledger → Settlement.
            Each step shows the live count across the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-stretch gap-1 overflow-x-auto pb-2">
            {PIPELINE_STEPS.map((step, i) => {
              const count = stats
                ? (stats as unknown as Record<string, number>)[step.key] ?? 0
                : 0
              const active = count > 0
              const Icon = step.icon
              return (
                <div key={step.key} className="flex items-stretch gap-1">
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.3 }}
                    className={cn(
                      "flex min-w-[120px] flex-1 flex-col gap-1 rounded-lg border p-3 transition-colors",
                      active ? "border-emerald-200 bg-emerald-50" : "border-border bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon
                        className={cn(
                          "size-3.5",
                          active ? "text-emerald-600" : "text-muted-foreground",
                        )}
                      />
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        {step.label}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "text-xl font-semibold tabular-nums",
                        active ? "text-emerald-700" : "text-muted-foreground",
                      )}
                    >
                      {count.toLocaleString()}
                    </span>
                  </motion.div>
                  {i < PIPELINE_STEPS.length - 1 && (
                    <ChevronRight className="my-auto size-4 shrink-0 text-muted-foreground/50" />
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Run E2E flow */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Play className="size-4 text-emerald-600" />
            Run End-to-End Flow
          </CardTitle>
          <CardDescription>
            Provisions a fresh tenant and runs the full telemetry → settlement vertical slice.
            Takes 1–2 seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <div className="space-y-1.5">
              <label htmlFor="tpl-select" className="text-xs font-medium text-muted-foreground">
                Template
              </label>
              <Select value={templateKey} onValueChange={onTemplateChange}>
                <SelectTrigger id="tpl-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="generic-resource-network">Generic Resource Network</SelectItem>
                  <SelectItem value="energy-vpp">Energy Virtual Power Plant</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="payload-input" className="text-xs font-medium text-muted-foreground">
                Payload (JSON)
              </label>
              <Textarea
                id="payload-input"
                value={payload}
                onChange={(e) => onPayloadChange(e.target.value)}
                className="min-h-[72px] font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={onRunE2E}
              disabled={running}
              className="bg-emerald-600 text-white shadow-xs hover:bg-emerald-600/90"
            >
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  Run Full Flow
                </>
              )}
            </Button>
            <span className="text-xs text-muted-foreground">
              Creates a new tenant · idempotent on event_id
            </span>
          </div>

          {result && <E2EResultTimeline result={result} />}
        </CardContent>
      </Card>
    </div>
  )
}

function ChainRow({
  icon: Icon,
  label,
  id,
  tone = "emerald",
  children,
  delay = 0,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  id?: string | null
  tone?: Tone
  children?: React.ReactNode
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="flex gap-3"
    >
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "flex size-8 items-center justify-center rounded-full border",
            TONE_CLASSES[tone],
          )}
        >
          <Icon className="size-4" />
        </div>
        <div className="w-px flex-1 bg-border" />
      </div>
      <div className="flex-1 space-y-1 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {id && <CopyableId id={id} label={`${label} id`} />}
        </div>
        {children}
      </div>
    </motion.div>
  )
}

function E2EResultTimeline({ result }: { result: E2EResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="rounded-lg border bg-muted/20 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <CircleCheck className="size-4 text-emerald-600" />
          Flow completed
        </h4>
        <Badge variant="outline" className={TONE_CLASSES[toneForStatus(result.settlement.status)]}>
          {result.settlement.status}
        </Badge>
      </div>

      <div className="space-y-0">
        <ChainRow icon={Building2} label="Tenant" id={result.tenant.id} tone="emerald" delay={0}>
          <p className="text-xs text-muted-foreground">slug: {result.tenant.slug}</p>
        </ChainRow>
        <ChainRow icon={Network} label="Network" id={result.network.id} tone="emerald" delay={0.05}>
          <p className="text-xs text-muted-foreground">
            slug: {result.network.slug} · version:{" "}
            <span className="font-mono">{truncateId(result.network.version_id)}</span>
          </p>
        </ChainRow>
        <ChainRow icon={User} label="Operator" id={result.operator.id} delay={0.1} />
        <ChainRow icon={Server} label="Asset" id={result.asset.id} delay={0.15} />
        <ChainRow icon={Cpu} label="Device" id={result.device.id} delay={0.2}>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800">
              <Lock className="size-3" />
              Provisioning secret — shown once
            </p>
            <code className="mt-1 block break-all font-mono text-xs text-amber-900">
              {result.device.provisioning_secret}
            </code>
          </div>
        </ChainRow>
        <ChainRow
          icon={Activity}
          label="Event"
          id={result.event.id}
          tone={result.event.status === "verified" ? "emerald" : "rose"}
          delay={0.25}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>external_id:</span>
            <span className="font-mono">{result.event.external_event_id}</span>
            <StatusBadge status={result.event.status} />
          </div>
        </ChainRow>
        <ChainRow
          icon={ShieldCheck}
          label="Verification"
          tone={result.verification.overall_status === "verified" ? "emerald" : "rose"}
          delay={0.3}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {result.verification.checks.map((c) => {
              const tone = c.status === "pass" ? "emerald" : c.status === "fail" ? "rose" : "muted"
              return (
                <Badge
                  key={c.name}
                  variant="outline"
                  className={cn("font-mono text-[10px]", TONE_CLASSES[tone])}
                  title={c.detail}
                >
                  {c.name}: {c.status}
                </Badge>
              )
            })}
            <span className="text-xs text-muted-foreground">
              confidence: {(result.verification.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </ChainRow>
        <ChainRow icon={Check} label="Attestation" id={result.attestation.id} delay={0.35}>
          <p className="text-xs text-muted-foreground">
            {result.attestation.quantity} {result.attestation.unit}
          </p>
        </ChainRow>
        <ChainRow icon={Boxes} label="Contribution" id={result.contribution.id} delay={0.4}>
          <p className="text-xs text-muted-foreground">
            {result.contribution.quantity} {result.contribution.unit}
          </p>
        </ChainRow>
        <ChainRow icon={Coins} label="Reward" id={result.reward.id} tone="emerald" delay={0.45}>
          <p className="text-xs text-muted-foreground">
            {formatCurrency(result.reward.amount, result.reward.currency)}
          </p>
        </ChainRow>
        <ChainRow icon={BookOpen} label="Ledger" id={result.ledger.reward_credit_entry_id} delay={0.5}>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              fee entry: <span className="font-mono">{truncateId(result.ledger.platform_fee_entry_id)}</span>
            </span>
            <span>
              balance after:{" "}
              <span className="font-mono text-emerald-700">
                {formatCurrency(result.ledger.balance_after)}
              </span>
            </span>
          </div>
        </ChainRow>
        <ChainRow
          icon={CircleCheck}
          label="Settlement"
          id={result.settlement.id}
          tone={result.settlement.status === "completed" ? "emerald" : "amber"}
          delay={0.55}
        >
          <p className="text-xs text-muted-foreground">
            provider payout:{" "}
            <span className="font-mono">{result.settlement.provider_payout_id ?? "—"}</span>
          </p>
        </ChainRow>
      </div>
    </motion.div>
  )
}

// ===========================================================================
// Entities tab
// ===========================================================================

type EntityTab = "operators" | "assets" | "devices" | "networks" | "events"

function EntitiesTab({
  tenantId,
  refreshKey,
}: {
  tenantId: string | undefined
  refreshKey: number
}) {
  const [sub, setSub] = useState<EntityTab>("operators")
  const paths: Record<EntityTab, string> = {
    operators: "/api/v1/operators",
    assets: "/api/v1/assets",
    devices: "/api/v1/devices",
    networks: "/api/v1/networks",
    events: "/api/v1/events?limit=50",
  }
  const { data, loading, error } = useApi<Entity[]>(paths[sub], tenantId, refreshKey)

  const tabs: { key: EntityTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "operators", label: "Operators", icon: User },
    { key: "assets", label: "Assets", icon: Server },
    { key: "devices", label: "Devices", icon: Cpu },
    { key: "networks", label: "Networks", icon: Network },
    { key: "events", label: "Events", icon: Activity },
  ]

  return (
    <Card className="py-0">
      <CardHeader className="border-b py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-emerald-600" />
            Entities
          </CardTitle>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
            {tabs.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSub(t.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    sub === t.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error ? (
          <div className="p-4">
            <ErrorState message={error} />
          </div>
        ) : loading ? (
          <div className="p-4">
            <TableSkeleton />
          </div>
        ) : !data || data.length === 0 ? (
          <div className="p-4">
            <EmptyState message={`No ${sub} yet. Run the E2E flow to populate.`} />
          </div>
        ) : (
          <ScrollArea className="max-h-[28rem]">
            <div className="p-0">
              {sub === "operators" && <OperatorsTable rows={data} />}
              {sub === "assets" && <AssetsTable rows={data} />}
              {sub === "devices" && <DevicesTable rows={data} />}
              {sub === "networks" && <NetworksTable rows={data} />}
              {sub === "events" && <EventsTable rows={data} />}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function Cell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <TableCell className={cn("py-2", className)}>{children}</TableCell>
}

function OperatorsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Trust</TableHead>
          <TableHead>Organization</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={asString(r.id)}>
            <Cell className="font-medium">{asString(r.displayName)}</Cell>
            <Cell><StatusBadge status={asString(r.status)} /></Cell>
            <Cell className="tabular-nums">
              {r.trustScore != null ? Number(r.trustScore).toFixed(2) : "—"}
            </Cell>
            <Cell className="text-muted-foreground">
              {asString((r.organization as Entity | null)?.name) || "—"}
            </Cell>
            <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
            <Cell><CopyableId id={asString(r.id)} label="operator id" /></Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function AssetsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Operator</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Devices</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const devices = (r.devices as Entity[] | undefined) ?? []
          return (
            <TableRow key={asString(r.id)}>
              <Cell className="font-medium">{asString(r.name)}</Cell>
              <Cell>
                <Badge variant="outline" className={TONE_CLASSES.teal}>
                  {asString(r.assetType)}
                </Badge>
              </Cell>
              <Cell className="text-muted-foreground">
                {asString((r.operator as Entity | null)?.displayName) || "—"}
              </Cell>
              <Cell><StatusBadge status={asString(r.status)} /></Cell>
              <Cell className="text-muted-foreground">{asString(r.location) || "—"}</Cell>
              <Cell className="tabular-nums">{devices.length}</Cell>
              <Cell><CopyableId id={asString(r.id)} label="asset id" /></Cell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function DevicesTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Manufacturer / Model</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Asset</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={asString(r.id)}>
            <Cell className="font-medium">{asString(r.deviceType)}</Cell>
            <Cell className="text-muted-foreground">
              {[asString(r.manufacturer), asString(r.model)].filter(Boolean).join(" · ") || "—"}
            </Cell>
            <Cell><StatusBadge status={asString(r.status)} /></Cell>
            <Cell className="text-muted-foreground">
              {asString((r.asset as Entity | null)?.name) || "—"}
            </Cell>
            <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
            <Cell><CopyableId id={asString(r.id)} label="device id" /></Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function NetworksTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead>Vertical</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Current Version</TableHead>
          <TableHead>Versions</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const versions = (r.versions as Entity[] | undefined) ?? []
          const current = versions.find((v) => asString(v.id) === asString(r.currentVersionId))
          return (
            <TableRow key={asString(r.id)}>
              <Cell className="font-medium">{asString(r.name)}</Cell>
              <Cell className="font-mono text-xs text-muted-foreground">{asString(r.slug)}</Cell>
              <Cell>
                <Badge variant="outline" className={TONE_CLASSES.teal}>
                  {asString(r.vertical)}
                </Badge>
              </Cell>
              <Cell><StatusBadge status={asString(r.status)} /></Cell>
              <Cell className="tabular-nums">{current ? `v${current.version}` : "—"}</Cell>
              <Cell className="tabular-nums">{versions.length}</Cell>
              <Cell><CopyableId id={asString(r.id)} label="network id" /></Cell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function EventsTable({ rows }: { rows: Entity[] }) {
  const [selected, setSelected] = useState<Entity | null>(null)
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>External ID</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Occurred</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>Internal ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={asString(r.id)}
              className="cursor-pointer"
              onClick={() => setSelected(r)}
            >
              <Cell>
                <span className="font-mono text-xs">{asString(r.externalEventId)}</span>
              </Cell>
              <Cell>
                <Badge variant="outline" className={TONE_CLASSES.muted}>
                  {asString(r.eventType)}
                </Badge>
              </Cell>
              <Cell><StatusBadge status={asString(r.status)} /></Cell>
              <Cell><RelativeTime date={asString(r.occurredAt)} /></Cell>
              <Cell><CopyableId id={asString(r.deviceId)} label="device id" /></Cell>
              <Cell><CopyableId id={asString(r.id)} label="event id" /></Cell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <EventDetailDialog row={selected} onClose={() => setSelected(null)} />
    </>
  )
}

function EventDetailDialog({ row, onClose }: { row: Entity | null; onClose: () => void }) {
  const verification = row ? (row.verification as Entity | null) : null
  const checks = verification
    ? (safeParseJson(asString(verification.checksJson)) as VerificationCheck[] | null)
    : null
  const payload = row ? safeParseJson(asString(row.payloadJson)) : null

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-4 text-emerald-600" />
            Event detail
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{row ? asString(row.externalEventId) : ""}</span>
          </DialogDescription>
        </DialogHeader>
        {row && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <StatusBadge status={asString(row.status)} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Type</p>
                <p className="font-mono text-xs">{asString(row.eventType)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Event ID</p>
                <CopyableId id={asString(row.id)} label="event id" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Device ID</p>
                <CopyableId id={asString(row.deviceId)} label="device id" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Asset</p>
                <CopyableId id={asString(row.assetId)} label="asset id" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Network version</p>
                <CopyableId id={asString(row.networkVersionId)} label="version id" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Occurred at</p>
                <p className="text-xs">
                  {row.occurredAt ? format(new Date(asString(row.occurredAt)), "PPpp") : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Received at</p>
                <p className="text-xs">
                  {row.receivedAt ? format(new Date(asString(row.receivedAt)), "PPpp") : "—"}
                </p>
              </div>
            </div>

            <Separator />

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                Verification checks
              </p>
              {verification ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={asString(verification.overallStatus)} />
                    <span className="text-xs text-muted-foreground">
                      confidence: {Number(verification.confidence ?? 0).toFixed(2)} · risk:{" "}
                      {Number(verification.risk ?? 0).toFixed(2)}
                    </span>
                  </div>
                  {checks && checks.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {checks.map((c) => {
                        const tone =
                          c.status === "pass" ? "emerald" : c.status === "fail" ? "rose" : "muted"
                        return (
                          <Badge
                            key={c.name}
                            variant="outline"
                            className={cn("font-mono text-[10px]", TONE_CLASSES[tone])}
                            title={c.detail}
                          >
                            {c.name}: {c.status}
                          </Badge>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No verification recorded.</p>
              )}
            </div>

            <Separator />

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileJson className="size-3.5" />
                Payload
              </p>
              <pre className="max-h-60 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ===========================================================================
// Economics tab
// ===========================================================================

type EconTab = "contributions" | "rewards" | "accounts" | "entries" | "settlements"

function EconomicsTab({
  tenantId,
  refreshKey,
}: {
  tenantId: string | undefined
  refreshKey: number
}) {
  const [sub, setSub] = useState<EconTab>("rewards")

  const paths: Record<EconTab, string> = {
    contributions: "/api/v1/contributions",
    rewards: "/api/v1/rewards",
    accounts: "/api/v1/ledger/accounts",
    entries: "/api/v1/ledger/entries",
    settlements: "/api/v1/payouts",
  }
  const { data, loading, error } = useApi<Entity[]>(paths[sub], tenantId, refreshKey)

  const tabs: { key: EconTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "rewards", label: "Rewards", icon: Coins },
    { key: "contributions", label: "Contributions", icon: Boxes },
    { key: "accounts", label: "Ledger Accounts", icon: Wallet },
    { key: "entries", label: "Ledger Entries", icon: BookOpen },
    { key: "settlements", label: "Settlements", icon: Banknote },
  ]

  return (
    <Card className="py-0">
      <CardHeader className="border-b py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="size-4 text-emerald-600" />
            Economics
          </CardTitle>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
            {tabs.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSub(t.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    sub === t.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error ? (
          <div className="p-4"><ErrorState message={error} /></div>
        ) : loading ? (
          <div className="p-4"><TableSkeleton /></div>
        ) : !data || data.length === 0 ? (
          <div className="p-4"><EmptyState message={`No ${sub} yet. Run the E2E flow to populate.`} /></div>
        ) : (
          <ScrollArea className="max-h-[28rem]">
            <div className="p-0">
              {sub === "contributions" && <ContributionsTable rows={data} />}
              {sub === "rewards" && <RewardsTable rows={data} />}
              {sub === "accounts" && <AccountsTable rows={data} />}
              {sub === "entries" && <EntriesTable rows={data} />}
              {sub === "settlements" && <SettlementsTable rows={data} />}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function ContributionsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Quantity</TableHead>
          <TableHead>Unit</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Operator</TableHead>
          <TableHead>Asset</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={asString(r.id)}>
            <Cell className="font-semibold tabular-nums">{Number(r.quantity ?? 0).toFixed(3)}</Cell>
            <Cell className="text-muted-foreground">{asString(r.unit)}</Cell>
            <Cell><StatusBadge status={asString(r.status)} /></Cell>
            <Cell className="text-muted-foreground">
              {asString((r.operator as Entity | null)?.displayName) || "—"}
            </Cell>
            <Cell className="text-muted-foreground">
              {asString((r.asset as Entity | null)?.name) || "—"}
            </Cell>
            <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
            <Cell><CopyableId id={asString(r.id)} label="contribution id" /></Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function RewardsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Operator</TableHead>
          <TableHead>Contribution</TableHead>
          <TableHead>Rule</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const rule = r.rule as Entity | undefined
          return (
            <TableRow key={asString(r.id)}>
              <Cell className="font-semibold tabular-nums text-emerald-700">
                {formatCurrency(Number(r.amount ?? 0), asString(r.currency) || "USD")}
              </Cell>
              <Cell><StatusBadge status={asString(r.status)} /></Cell>
              <Cell className="text-muted-foreground">
                {asString((r.operator as Entity | null)?.displayName) || "—"}
              </Cell>
              <Cell><CopyableId id={asString(r.contributionId)} label="contribution id" /></Cell>
              <Cell className="text-muted-foreground">
                {rule ? (
                  <span className="font-mono text-xs">
                    {asString(rule.ruleType)} @ {asString(rule.rate)}/{asString(rule.unit)}
                  </span>
                ) : "—"}
              </Cell>
              <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
              <Cell><CopyableId id={asString(r.id)} label="reward id" /></Cell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function AccountsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Owner Type</TableHead>
          <TableHead>Owner ID</TableHead>
          <TableHead>Currency</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const balance = Number(r.balance ?? 0)
          return (
            <TableRow key={asString(r.id)}>
              <Cell>
                <Badge variant="outline" className={TONE_CLASSES[toneForStatus(asString(r.ownerType))]}>
                  {asString(r.ownerType)}
                </Badge>
              </Cell>
              <Cell><CopyableId id={asString(r.ownerId)} label="owner id" /></Cell>
              <Cell className="text-muted-foreground">{asString(r.currency)}</Cell>
              <Cell className="text-right font-semibold tabular-nums">
                <span className={balance < 0 ? "text-rose-600" : balance > 0 ? "text-emerald-700" : ""}>
                  {formatCurrency(balance, asString(r.currency) || "USD")}
                </span>
              </Cell>
              <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function EntriesTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Currency</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const amt = Number(r.amount ?? 0)
          return (
            <TableRow key={asString(r.id)}>
              <Cell>
                <Badge variant="outline" className={TONE_CLASSES.muted}>
                  {asString(r.entryType)}
                </Badge>
              </Cell>
              <Cell className="tabular-nums">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-medium",
                    amt < 0 ? "text-rose-600" : "text-emerald-700",
                  )}
                >
                  {amt < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
                  {formatCurrency(Math.abs(amt), asString(r.currency) || "USD")}
                </span>
              </Cell>
              <Cell className="text-muted-foreground">{asString(r.currency)}</Cell>
              <Cell className="text-muted-foreground">
                {asString(r.referenceType) || "—"}{" "}
                {r.referenceId && <CopyableId id={asString(r.referenceId)} label="reference id" />}
              </Cell>
              <Cell><CopyableId id={asString(r.accountId)} label="account id" /></Cell>
              <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
              <Cell><CopyableId id={asString(r.id)} label="entry id" /></Cell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function SettlementsTable({ rows }: { rows: Entity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Payout ID</TableHead>
          <TableHead>Reward</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={asString(r.id)}>
            <Cell className="font-semibold tabular-nums text-emerald-700">
              {formatCurrency(Number(r.amount ?? 0), asString(r.currency) || "USD")}
            </Cell>
            <Cell><StatusBadge status={asString(r.status)} /></Cell>
            <Cell className="text-muted-foreground">
              <span className="font-mono text-xs">{asString(r.provider)}</span>
            </Cell>
            <Cell>
              {r.providerPayoutId ? (
                <CopyableId id={asString(r.providerPayoutId)} label="payout id" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Cell>
            <Cell><CopyableId id={asString(r.rewardId)} label="reward id" /></Cell>
            <Cell><RelativeTime date={asString(r.createdAt)} /></Cell>
            <Cell><CopyableId id={asString(r.id)} label="settlement id" /></Cell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ===========================================================================
// Audit tab
// ===========================================================================

function AuditTab({
  tenantId,
  refreshKey,
}: {
  tenantId: string | undefined
  refreshKey: number
}) {
  const { data, loading, error } = useApi<Entity[]>(
    "/api/v1/audit?limit=100",
    tenantId,
    refreshKey,
  )

  return (
    <Card className="py-0">
      <CardHeader className="border-b py-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4 text-emerald-600" />
          Audit Log
          {data && data.length > 0 && (
            <Badge variant="secondary" className="ml-1 tabular-nums">{data.length}</Badge>
          )}
        </CardTitle>
        <CardDescription>Append-only, application-immutable record of state changes.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {error ? (
          <div className="p-4"><ErrorState message={error} /></div>
        ) : loading ? (
          <div className="p-4"><TableSkeleton rows={8} cols={3} /></div>
        ) : !data || data.length === 0 ? (
          <div className="p-4"><EmptyState message="No audit events yet." /></div>
        ) : (
          <ScrollArea className="max-h-[600px]">
            <div className="divide-y">
              {data.map((r) => {
                const meta = safeParseJson(asString(r.metadataJson))
                const tone = toneForAuditEvent(asString(r.eventType))
                return (
                  <div
                    key={asString(r.id)}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                  >
                    <div className="flex w-44 shrink-0 items-center gap-2">
                      <CircleDot className={cn("size-3 shrink-0", TONE_DOT[tone])} />
                      <RelativeTime date={asString(r.createdAt)} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("font-mono text-[10px]", TONE_CLASSES[tone])}>
                        {asString(r.eventType)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{asString(r.resourceType)}</span>
                      <CopyableId id={asString(r.resourceId)} label="resource id" />
                    </div>
                    <div className="w-full sm:w-auto sm:flex-1">
                      {meta && typeof meta === "object" && Object.keys(meta as object).length > 0 ? (
                        <details className="group">
                          <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                            <FileJson className="size-3" />
                            metadata
                          </summary>
                          <pre className="mt-1 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                            {JSON.stringify(meta, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">no metadata</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// Templates tab
// ===========================================================================

function TemplatesTab({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useApi<{ templates: Template[] }>(
    "/api/v1/templates",
    undefined,
    refreshKey,
  )
  const templates = data?.templates ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <LayoutTemplate className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <p>
          Network templates prove the platform is general-purpose — a new vertical only needs a new
          template, never a change to core domain code.
        </p>
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState message="No templates available." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((t, i) => (
            <motion.div
              key={t.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.3 }}
            >
              <Card className="h-full">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{t.name}</CardTitle>
                      <CardDescription className="mt-1">
                        <Badge variant="outline" className={TONE_CLASSES.teal}>
                          {t.vertical}
                        </Badge>
                      </CardDescription>
                    </div>
                    <Cog className="size-4 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{t.description}</p>

                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Asset types</p>
                    <div className="flex flex-wrap gap-1.5">
                      {t.asset_types.map((a) => (
                        <Badge key={a} variant="outline" className={TONE_CLASSES.muted}>
                          {a}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Capabilities</p>
                    <div className="flex flex-wrap gap-1.5">
                      {t.capabilities.map((c) => (
                        <Badge key={c.type} variant="outline" className={TONE_CLASSES.teal}>
                          {c.type} · {c.unit}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Verification checks</p>
                    <div className="flex flex-wrap gap-1.5">
                      {t.verification.checks.map((c) => (
                        <Badge
                          key={c}
                          variant="outline"
                          className={cn("font-mono text-[10px]", TONE_CLASSES.emerald)}
                        >
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Reward policy</p>
                      <p className="font-mono text-xs">
                        {t.reward.type} · {t.reward.rate} {t.reward.currency}/{t.reward.unit}
                      </p>
                    </div>
                    {t.reward.platform_fee_pct != null && (
                      <div className="text-right">
                        <p className="text-xs font-medium text-muted-foreground">Platform fee</p>
                        <p className="font-mono text-xs text-amber-700">{t.reward.platform_fee_pct}%</p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// Header
// ===========================================================================

function Header({
  tenants,
  tenantsLoading,
  selectedTenantId,
  onTenantChange,
  onRefresh,
  refreshing,
  onRunE2E,
  runningE2E,
}: {
  tenants: Tenant[]
  tenantsLoading: boolean
  selectedTenantId: string
  onTenantChange: (id: string) => void
  onRefresh: () => void
  refreshing: boolean
  onRunE2E: () => void
  runningE2E: boolean
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
            <Network className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight sm:text-base">
              Infrastructure-as-a-Network
            </h1>
            <p className="text-[11px] text-muted-foreground">Operator Console</p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={selectedTenantId} onValueChange={onTenantChange}>
            <SelectTrigger
              className="h-9 w-[220px] gap-2"
              aria-label="Select tenant"
              disabled={tenantsLoading}
            >
              <Building2 className="size-3.5 text-muted-foreground" />
              <SelectValue placeholder={tenantsLoading ? "Loading tenants…" : "Select tenant"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Default (first active)</SelectItem>
              {tenants.length > 0 && <SelectSeparator />}
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{t.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{t.slug}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh data"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>

          <Button
            size="sm"
            onClick={onRunE2E}
            disabled={runningE2E}
            className="bg-emerald-600 text-white shadow-xs hover:bg-emerald-600/90"
          >
            {runningE2E ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            <span className="hidden sm:inline">Run E2E Flow</span>
            <span className="sm:hidden">E2E</span>
          </Button>
        </div>
      </div>
    </header>
  )
}

// ===========================================================================
// Footer
// ===========================================================================

function Footer({ health }: { health: HealthStatus | null }) {
  const ok = health?.status === "ok"
  return (
    <footer className="mt-auto border-t bg-muted/30">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground sm:px-6">
        <p>Infrastructure-as-a-Network Platform — MVP</p>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              ok ? "bg-emerald-500" : "bg-rose-500",
            )}
            aria-hidden
          />
          <span className={ok ? "text-emerald-700" : "text-rose-600"}>
            {ok ? "System OK" : "Degraded"}
          </span>
          {health?.counts && (
            <span className="hidden text-muted-foreground sm:inline">
              {" · "}
              {Object.entries(health.counts)
                .map(([k, v]) => `${k}: ${v}`)
                .join("  ")}
            </span>
          )}
        </div>
      </div>
    </footer>
  )
}

// ===========================================================================
// Main page
// ===========================================================================

export default function Home() {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantsLoading, setTenantsLoading] = useState(true)
  const [selectedTenantId, setSelectedTenantId] = useState<string>("__default__")
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [activeTab, setActiveTab] = useState("pipeline")

  // E2E state — lifted so the header button and Pipeline tab share it.
  const [templateKey, setTemplateKey] = useState<string>("generic-resource-network")
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOADS["generic-resource-network"])
  const [e2eRunning, setE2eRunning] = useState(false)
  const [e2eResult, setE2eResult] = useState<E2EResult | null>(null)

  // Load tenants once per refresh.
  useEffect(() => {
    let cancelled = false
    setTenantsLoading(true)
    apiFetch<Tenant[]>("/api/v1/tenants")
      .then((t) => {
        if (cancelled) return
        setTenants(t)
        setTenantsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setTenantsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Fetch stats (global; no tenant header). Poll every 15s.
  useEffect(() => {
    let cancelled = false
    const fetchStats = () => {
      setStatsLoading(true)
      apiFetch<Stats>("/api/v1/dashboard/stats")
        .then((s) => {
          if (!cancelled) {
            setStats(s)
            setStatsLoading(false)
          }
        })
        .catch(() => {
          if (!cancelled) setStatsLoading(false)
        })
    }
    fetchStats()
    const id = setInterval(fetchStats, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refreshKey])

  // Fetch health. Poll every 30s.
  useEffect(() => {
    let cancelled = false
    const fetchHealth = () => {
      apiFetch<HealthStatus>("/api/internal/health")
        .then((h) => {
          if (!cancelled) setHealth(h)
        })
        .catch(() => {})
    }
    fetchHealth()
    const id = setInterval(fetchHealth, 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refreshKey])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    setRefreshKey((k) => k + 1)
    setTimeout(() => setRefreshing(false), 600)
  }, [])

  const onTenantChange = useCallback((id: string) => {
    setSelectedTenantId(id)
    setRefreshKey((k) => k + 1)
  }, [])

  const onTemplateChange = useCallback((key: string) => {
    setTemplateKey(key)
    setPayload(DEFAULT_PAYLOADS[key] ?? "{}")
  }, [])

  const runE2E = useCallback(async () => {
    let parsedPayload: unknown = undefined
    if (payload.trim()) {
      try {
        parsedPayload = JSON.parse(payload)
      } catch (e) {
        toast.error("Invalid JSON payload", {
          description: e instanceof Error ? e.message : "Parse error",
        })
        return
      }
    }
    setActiveTab("pipeline")
    setE2eRunning(true)
    try {
      const res = await apiFetch<E2EResult>("/api/v1/dashboard/e2e", {
        method: "POST",
        body: { templateKey, payload: parsedPayload },
      })
      setE2eResult(res)
      toast.success("End-to-end flow completed", {
        description: `Settlement ${res.settlement.status} · ${formatCurrency(
          res.reward.amount,
          res.reward.currency,
        )}`,
      })
      setRefreshKey((k) => k + 1)
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Unknown error"
      toast.error("End-to-end flow failed", { description: msg })
    } finally {
      setE2eRunning(false)
    }
  }, [templateKey, payload])

  const tenantHeader =
    selectedTenantId && selectedTenantId !== "__default__" ? selectedTenantId : undefined

  const successRate = stats?.verification_success_rate ?? 0
  const successTone: Tone = successRate > 80 ? "emerald" : successRate >= 50 ? "amber" : "rose"

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Toaster position="top-right" richColors closeButton />

      <Header
        tenants={tenants}
        tenantsLoading={tenantsLoading}
        selectedTenantId={selectedTenantId}
        onTenantChange={onTenantChange}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onRunE2E={runE2E}
        runningE2E={e2eRunning}
      />

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        {/* KPI row */}
        <section
          aria-label="Key metrics"
          className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4"
        >
          <KpiCard
            icon={Activity}
            label="Events Received"
            value={stats ? stats.events_received.toLocaleString() : "—"}
            sublabel={
              stats ? (
                <>
                  <span className="text-emerald-600">{stats.events_verified}</span>
                  <span className="text-muted-foreground"> verified · </span>
                  <span className="text-rose-600">{stats.events_rejected}</span>
                  <span className="text-muted-foreground"> rejected</span>
                </>
              ) : undefined
            }
            loading={statsLoading && !stats}
            delay={0}
          />
          <KpiCard
            icon={ShieldCheck}
            label="Verification Success"
            value={`${successRate.toFixed(1)}%`}
            sublabelTone={successTone}
            sublabel={
              stats ? `${stats.events_verified} of ${stats.events_received} verified` : undefined
            }
            loading={statsLoading && !stats}
            delay={0.05}
          />
          <KpiCard
            icon={Coins}
            label="Rewards Calculated"
            value={stats ? stats.rewards.toLocaleString() : "—"}
            sublabel={stats ? `${formatCurrency(stats.total_reward_amount)} total` : undefined}
            loading={statsLoading && !stats}
            delay={0.1}
          />
          <KpiCard
            icon={CircleCheck}
            label="Settlements Completed"
            value={stats ? stats.settlements_completed.toLocaleString() : "—"}
            sublabelTone={stats && stats.settlements_failed > 0 ? "rose" : "muted"}
            sublabel={
              stats ? (
                <>
                  {stats.settlements_failed > 0 ? (
                    <span className="text-rose-600">{stats.settlements_failed} failed</span>
                  ) : (
                    <span className="text-muted-foreground">0 failed</span>
                  )}
                  <span className="text-muted-foreground">
                    {" "}· {formatCurrency(stats.total_settled_amount)} settled
                  </span>
                </>
              ) : undefined
            }
            loading={statsLoading && !stats}
            delay={0.15}
          />
        </section>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 p-1">
            <TabsTrigger value="pipeline" className="gap-1.5">
              <CircuitBoard className="size-3.5" />
              Pipeline
            </TabsTrigger>
            <TabsTrigger value="entities" className="gap-1.5">
              <Layers className="size-3.5" />
              Entities
            </TabsTrigger>
            <TabsTrigger value="economics" className="gap-1.5">
              <Receipt className="size-3.5" />
              Economics
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <ListChecks className="size-3.5" />
              Audit Log
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-1.5">
              <LayoutTemplate className="size-3.5" />
              Templates
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline">
            <PipelineTab
              stats={stats}
              templateKey={templateKey}
              payload={payload}
              running={e2eRunning}
              result={e2eResult}
              onTemplateChange={onTemplateChange}
              onPayloadChange={setPayload}
              onRunE2E={runE2E}
            />
          </TabsContent>

          <TabsContent value="entities">
            <EntitiesTab tenantId={tenantHeader} refreshKey={refreshKey} />
          </TabsContent>

          <TabsContent value="economics">
            <EconomicsTab tenantId={tenantHeader} refreshKey={refreshKey} />
          </TabsContent>

          <TabsContent value="audit">
            <AuditTab tenantId={tenantHeader} refreshKey={refreshKey} />
          </TabsContent>

          <TabsContent value="templates">
            <TemplatesTab refreshKey={refreshKey} />
          </TabsContent>
        </Tabs>
      </main>

      <Footer health={health} />
    </div>
  )
}
