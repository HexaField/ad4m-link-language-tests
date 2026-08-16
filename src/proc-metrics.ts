/**
 * Process metrics utilities — shared across scenarios.
 *
 * Consolidates the `getRssKb`/`getExecutorPid` helpers duplicated across 11
 * scenario files (s2b, s3, s4, s7, s9, s10, s12, s14, s15, m4, m5) and adds
 * CPU measurement via `/proc/PID/stat` — instantaneous CPU%, not the
 * lifetime average `ps -o %cpu=` reports.
 *
 * PID namespaces: the wind tunnel starts the AD4M executor as a direct host
 * process (see executor.ts), so PIDs resolved via `lsof`/`ps` are already
 * host PIDs and `/proc/<pid>/stat` reads work unmodified. If a scenario ever
 * targets a containerized executor, the PID passed in must still be the
 * HOST-visible PID (e.g. from `docker inspect --format '{{.State.Pid}}'`),
 * not the PID as seen inside the container's own PID namespace — the host
 * kernel's `/proc` only understands host PIDs.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";

/**
 * Clock ticks per second on Linux (`getconf CLK_TCK`) — 100 on every
 * mainstream distro/kernel combination this harness targets.
 */
const CLK_TCK = 100;

/** Resolve the first PID listening on a port. */
export function getExecutorPid(port: number): number | null {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (!out) return null;
    const n = parseInt(out.split("\n")[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read current RSS in kilobytes from `ps`. */
export function getRssKb(pid: number): number | null {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** `utime` + `stime` (in clock ticks) plus the wall-clock time of capture. */
export interface ProcCpuSnapshot {
  utime: number;
  stime: number;
  /** `Date.now()` at capture time. */
  clockMs: number;
}

/** Per-thread CPU snapshot from `/proc/PID/task/TID/stat`. */
export interface ThreadCpuSnapshot {
  tid: number;
  name: string;
  utime: number;
  stime: number;
}

interface RawStatCpu {
  name: string;
  utime: number;
  stime: number;
}

/**
 * Parse `utime`/`stime`/`comm` out of a `/proc/.../stat` line.
 *
 * The comm field (2nd, in parentheses) can itself contain spaces or
 * parentheses, so it's located by the LAST `)` on the line rather than by
 * splitting naively on spaces. Everything after that closing paren is
 * space-separated starting at `state` (original field 3): `utime` is field
 * 14 (index 11 in the post-comm array), `stime` is field 15 (index 12).
 * See `man 5 proc`.
 */
function parseStatCpu(statPath: string): RawStatCpu | null {
  try {
    if (!existsSync(statPath)) return null;
    const raw = readFileSync(statPath, "utf8").trim();
    const commStart = raw.indexOf("(");
    const commEnd = raw.lastIndexOf(")");
    if (commStart < 0 || commEnd <= commStart) return null;
    const name = raw.substring(commStart + 1, commEnd);
    const fields = raw.substring(commEnd + 2).split(" ");
    const utime = parseInt(fields[11], 10);
    const stime = parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { name, utime, stime };
  } catch {
    return null;
  }
}

/**
 * Snapshot CPU ticks from `/proc/PID/stat`.
 * Returns null on non-Linux (no `/proc`) or if the file cannot be read —
 * e.g. the process exited between resolving its PID and sampling it.
 */
export function cpuSnapshot(pid: number): ProcCpuSnapshot | null {
  const parsed = parseStatCpu(`/proc/${pid}/stat`);
  if (!parsed) return null;
  return { utime: parsed.utime, stime: parsed.stime, clockMs: Date.now() };
}

/**
 * Compute CPU% of one core between two snapshots.
 * E.g. 11.2 means "11.2% of one core" over the sampled window — can exceed
 * 100 for a multi-threaded process using more than one core's worth of time.
 */
export function cpuPercent(before: ProcCpuSnapshot, after: ProcCpuSnapshot): number {
  const dTicks = (after.utime - before.utime) + (after.stime - before.stime);
  const dMs = after.clockMs - before.clockMs;
  if (dMs <= 0) return 0;
  const cpuMs = (dTicks / CLK_TCK) * 1000;
  return Math.max(0, (cpuMs / dMs) * 100);
}

/** Snapshot every thread's CPU ticks under `/proc/PID/task/`. */
export function threadCpuSnapshot(pid: number): ThreadCpuSnapshot[] {
  const taskDir = `/proc/${pid}/task`;
  if (!existsSync(taskDir)) return [];
  let tids: string[];
  try {
    tids = readdirSync(taskDir);
  } catch {
    return [];
  }
  const result: ThreadCpuSnapshot[] = [];
  for (const tidStr of tids) {
    const tid = parseInt(tidStr, 10);
    if (!Number.isFinite(tid)) continue;
    const parsed = parseStatCpu(`${taskDir}/${tidStr}/stat`);
    if (!parsed) continue;
    result.push({ tid, name: parsed.name, utime: parsed.utime, stime: parsed.stime });
  }
  return result;
}
