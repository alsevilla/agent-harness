// Runtime owner tracking for post-merge checkout cleanup: which worker ran in which folder, and until when. Memory only; a fresh session knows nothing, and unknown ownership always refuses.
const fold = (p: string): string => {
	const s = p.replace(/[\\]/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
};
// Equal, or one contains the other: a worker above a target is as live as one inside it.
export const overlaps = (a: string, b: string): boolean => {
	const x = fold(a), y = fold(b);
	return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

export interface OwnerRecord { workerId: string; role: string; cwd: string; jobId?: string; ended: boolean }

interface Reservation { target: string; expires: number; claimed: boolean }

export class OwnerTracker {
	private records = new Map<string, OwnerRecord>();
	// Keyed by cleanup scope id. An unclaimed reservation guards a scope still in the parent store; a claimed one guards a child that holds removal authority and is released only by its confirmed close (or TTL expiry).
	private reservations = new Map<string, Reservation>();
	// Registered before the process spawns. A folder reserved for cleanup admits no new worker.
	begin(r: { workerId: string; role: string; cwd: string; jobId?: string }): void {
		const now = Date.now();
		for (const [id, held] of this.reservations) {
			if (held.expires <= now) this.reservations.delete(id);
			else if (overlaps(held.target, r.cwd)) throw new Error("a checkout cleanup is pending for this folder; no worker may start in or above it");
		}
		this.records.set(r.workerId, { ...r, ended: false });
	}
	// Called only after the worker process has closed; idempotent.
	end(workerId: string): void {
		const record = this.records.get(workerId);
		if (record) record.ended = true;
	}
	reserve(target: string, expiresAt: number, id: string = target): void {
		this.reservations.set(id, { target, expires: expiresAt, claimed: false });
	}
	// A live (unexpired) reservation overlapping the folder: a cleanup for it is already pending, claimed or retained.
	reserved(target: string): boolean {
		const now = Date.now();
		return [...this.reservations.values()].some((held) => held.expires > now && overlaps(held.target, target));
	}
	// The child took the scope out of the parent store: from here the reservation is the only thing refusing an overlapping writer.
	markClaimed(id: string): void {
		const held = this.reservations.get(id);
		if (held) held.claimed = true;
	}
	// Confirmed child close. A clean exit releases; anything else (aborted, killed, failed) keeps the folder reserved until its TTL, because a shell the child started may outlive it and nothing here can see that.
	closeClaimed(id: string, cleanExit: boolean): void {
		if (cleanExit) this.reservations.delete(id);
	}
	// Only scopes that never left the parent store (their grants were just revoked). Claimed reservations are never dropped here.
	releaseUnclaimed(): void {
		for (const [id, held] of this.reservations) if (!held.claimed) this.reservations.delete(id);
	}
	clear(): void {
		this.records.clear();
		this.releaseUnclaimed();
	}
	// Fixed refusal reason, or undefined when every recorded worker touching the folder is terminal and a delivery owner is on record. No record at all is unknown, never idle.
	check(candidate: string, jobRunning: (jobId: string) => boolean): string | undefined {
		const touching = [...this.records.values()].filter((r) => overlaps(r.cwd, candidate));
		if (!touching.length) return "no known owner of this checkout in this session (unknown ownership is retained)";
		if (touching.some((r) => !r.ended)) return "an owner worker is still active or paused";
		if (touching.some((r) => r.jobId !== undefined && jobRunning(r.jobId))) return "an owner job is still running or paused";
		if (!touching.some((r) => r.role === "release-engineer")) return "no delivery owner is recorded for this checkout";
		return undefined;
	}
}
