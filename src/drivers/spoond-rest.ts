import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileListing,
	type FileWatcher,
	LineScanner,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputSkip,
	StreamDecoder,
	type TextLine,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import type { SpoondRequest } from "./spoond.ts";

/**
 * A lease's files and commands through spoond's REST API, with no connection held: commands are background jobs
 * followed by long polls and read by offset, file contents go through the files API, and what that API lacks (rename,
 * listings, lstat, …) runs as a short shell command in the lease. Results follow pi-env's `RemoteExecutionEnv`, so the
 * rest of Scout can't tell the two apart.
 */
export type SpoondRestOptions = {
	request: SpoondRequest;
	id: string;
	cwd: string;
	home: string;
	shellEnv?: Record<string, string>;
};

/** Seconds a finished job's record and output stay in spoond; Scout deletes them itself once read. */
const JOB_RETENTION = 600;
/** Longest long poll, so output still arrives while a command runs; polls start at a second and grow to it. */
const POLL_SECONDS = 5;
/** Bytes per output read; above any per-job cap Scout sets, so what follows a dropped front comes in one piece. */
const OUTPUT_LIMIT = 16 * 1024 * 1024;
/** Bytes per ranged file read. */
const READ_CHUNK = 1024 * 1024;
/** What the start of every command prints, alone on stderr, when it can't start (no such directory or program). */
const CANNOT_START = "scout:cannot-start";

type Sh = { stdout: string; stderr: string; exit: number };
type Job = { state: "running" | "exited" | "lost"; exit_code: number | null; reason?: string };
type Skip = { bytes?: number; newlines?: number; ends_with_newline?: boolean };

export class SpoondRestEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #request: SpoondRequest;
	readonly #home: string;
	readonly #shellEnv: Record<string, string>;
	readonly #running = new Set<string>();
	/** Whether this spoond answers `Range` on file reads; older ones send the whole file. */
	#ranges = true;

	constructor(options: SpoondRestOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.#request = options.request;
		this.#home = options.home;
		this.#shellEnv = options.shellEnv ?? {};
	}

	#resolve(path: string): string {
		let p = path;
		if (p === "~") p = this.#home;
		else if (p.startsWith("~/")) p = posix.join(this.#home, p.slice(2));
		else if (p.startsWith("file://")) {
			try {
				p = fileURLToPath(p);
			} catch {}
		}
		return posix.resolve(this.cwd, p);
	}

	/** A short command in the lease, buffered; for file operations the files API lacks. */
	async #sh(script: string): Promise<Sh> {
		const response = await this.#request("POST", "/exec", { body: JSON.stringify({ cmd: script, timeout: 60 }) });
		if (!response.ok) throw new Error(`spoond exec: ${response.status} ${(await response.text()).slice(0, 200)}`);
		return (await response.json()) as Sh;
	}

	/** A file operation as a shell script: its stdout, or its failure as a `FileError`. */
	async #fileSh(path: string, script: string, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
		try {
			const result = await this.#sh(`fail() { printf 'E:%s' "$1" >&2; exit 3; }\n${script}`);
			if (result.exit !== 0) return err(fileError(result.stderr, path));
			return ok(result.stdout);
		} catch (error) {
			return err(new FileError("unknown", error instanceof Error ? error.message : String(error), path));
		}
	}

	async #files(method: string, path: string, query = "", init: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {}): Promise<Response> {
		return this.#request(method, `/files${path.split("/").map(encodeURIComponent).join("/")}${query}`, init);
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.#resolve(path);
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", resolved));
		try {
			const response = await this.#files("GET", resolved);
			if (response.status === 200) return ok(new Uint8Array(await response.arrayBuffer()));
			const coded = await spoondFileError(response, resolved);
			if (coded !== undefined) return err(coded);
			// An older spoond says only that it can't: ask the lease why, the way Node would.
			const why = await this.#fileSh(resolved, `cat -- ${q(resolved)} >/dev/null`, context);
			return err(why.ok ? new FileError("unknown", `spoond answered ${response.status}`, resolved) : why.error);
		} catch (error) {
			return err(new FileError("unknown", error instanceof Error ? error.message : String(error), resolved));
		}
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		return bytes.ok ? ok(Buffer.from(bytes.value).toString("utf8")) : bytes;
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = this.#resolve(path);
		const bytes = await this.readBinaryFile(resolved, context);
		if (!bytes.ok) return bytes;
		const decoder = new StreamDecoder();
		return ok(new LinesReader(decoder.decode(bytes.value) + decoder.decode(), resolved));
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const reader = await this.openTextLineReader(path, context);
		if (!reader.ok) return reader;
		const lines: string[] = [];
		while (options?.maxLines === undefined || lines.length < options.maxLines) {
			const line = await reader.value.readLine(context);
			if (!line.ok) return line;
			if (line.value === undefined) break;
			lines.push(line.value.text);
		}
		return ok(lines);
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const resolved = this.#resolve(path);
		// A hard link keeps the opened file readable after a rename or replacement, as an open handle would; across file
		// systems there's no link, and the reader reads the path.
		const opened = await this.#fileSh(
			resolved,
			[
				`p=${q(resolved)}`,
				`[ -e "$p" ] || [ -L "$p" ] || fail not_found`,
				options?.noFollow ? `[ -L "$p" ] && fail invalid` : "",
				`[ -e "$p" ] || fail not_found`,
				`[ -d "$p" ] && fail is_directory`,
				`[ -f "$p" ] || fail invalid`,
				`t=$(mktemp -u "\${TMPDIR:-/tmp}/scout-open-XXXXXXXX")`,
				`if ln -L -- "$p" "$t" 2>/dev/null; then printf 'L%s' "$t"; else printf 'P%s' "$(realpath -- "$p")"; fi`,
			].join("\n"),
			context,
		);
		if (!opened.ok) return opened;
		return ok(new RangeReader(this, resolved, opened.value.slice(1), opened.value.startsWith("L")));
	}

	/** Bytes `[offset, offset + length)` of a file, fewer at its end. */
	async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
		if (length === 0) return new Uint8Array(0);
		if (this.#ranges) {
			const response = await this.#files("GET", path, "", { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
			if (response.status === 206) {
				const bytes = new Uint8Array(await response.arrayBuffer());
				// spoond serves at most 256 MiB at once; short of the end of the file, read on from where it stopped.
				const size = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
				if (bytes.length === 0 || bytes.length >= length || !(offset + bytes.length < size)) return bytes;
				const rest = await this.readRange(path, offset + bytes.length, length - bytes.length);
				const all = new Uint8Array(bytes.length + rest.length);
				all.set(bytes);
				all.set(rest, bytes.length);
				return all;
			}
			if (response.status === 416) return new Uint8Array(0);
			if (response.status === 200) {
				this.#ranges = false;
				return new Uint8Array(await response.arrayBuffer()).slice(offset, offset + length);
			}
			throw (await spoondFileError(response, path)) ?? new Error(`spoond answered ${response.status} reading ${path}`);
		}
		const read = await this.#sh(`tail -c +${offset + 1} -- ${q(path)} | head -c ${length} | base64 -w0`);
		if (read.exit !== 0) throw fileError(read.stderr, path);
		return new Uint8Array(Buffer.from(read.stdout, "base64"));
	}

	async infoOf(path: string, name: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const found = await this.#fileSh(path, `find ${q(path)} -maxdepth 0 -printf '%y\\t%s\\t%T@'`, context);
		if (!found.ok) return found;
		const info = toInfo(`${found.value}\t${name}`, posix.dirname(path));
		return info === undefined ? err(new FileError("invalid", "Not a file, directory or symbolic link", path)) : ok({ ...info, path });
	}

	async removeQuietly(path: string): Promise<void> {
		await this.#sh(`rm -f -- ${q(path)}`).catch(() => {});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", resolved));
		try {
			// A PUT replaces the file; keep the mode it had, so an edited script stays executable.
			const stat = await this.#files("GET", resolved, "?stat=1");
			const mode = stat.ok ? ((await stat.json()) as { mode?: string }).mode : (await stat.body?.cancel(), undefined);
			const put = await this.#files("PUT", resolved, `?mode=0${mode ?? "644"}`, { body: bytesOf(content) });
			if (put.status === 201 || put.status === 200) return (await put.body?.cancel(), ok(undefined));
			const coded = await spoondFileError(put, resolved);
			if (coded !== undefined) return err(coded);
			if (put.status === 409) return err(new FileError("is_directory", "Is a directory", resolved));
			return err(new FileError("unknown", `spoond answered ${put.status}`, resolved));
		} catch (error) {
			return err(new FileError("unknown", error instanceof Error ? error.message : String(error), resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const part = `/tmp/scout-append-${randomUUID()}`;
		const put = await this.#files("PUT", part, "?mode=0600", { body: bytesOf(content) });
		await put.body?.cancel();
		if (!put.ok) return err(new FileError("unknown", `spoond answered ${put.status}`, resolved));
		return this.#done(await this.#fileSh(resolved, `cat -- ${q(part)} >> ${q(resolved)}; s=$?; rm -f -- ${q(part)}; exit $s`, context));
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		return this.#done(await this.#fileSh(resolved, `[ -e ${q(resolved)} ] || fail not_found\ntruncate -s ${size} -- ${q(resolved)}`, context));
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		return this.#done(await this.#fileSh(resolved, `sync -- ${q(resolved)}`, context));
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.#resolve(sourcePath);
		return this.#done(await this.#fileSh(source, `mv -fT -- ${q(source)} ${q(this.#resolve(destinationPath))}`, context));
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.#resolve(path);
		return this.infoOf(resolved, posix.basename(resolved), context);
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.#resolve(path);
		const found = await this.#fileSh(resolved, `cd -- ${q(resolved)} || exit 1\nfind . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`, context);
		if (!found.ok) return found;
		const infos: FileInfo[] = [];
		for (const row of found.value.split("\0")) {
			const info = row === "" ? undefined : toInfo(row, resolved);
			if (info !== undefined) infos.push(info);
		}
		// Node's readdir order on POSIX: by the names' bytes.
		return ok(infos.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))));
	}

	/** Not until spoond lists directories itself (spoond-bvmc); Pi then walks the tree with `openDirReader`. */
	async listFiles(path: string, _options: unknown, _context: Context): Promise<Result<FileListing, FileError>> {
		return err(new FileError("not_supported", "spoond can't list files yet", this.#resolve(path)));
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = this.#resolve(path);
		const listed = await this.listDir(resolved, context);
		if (!listed.ok) return listed;
		return ok(new PagedDirReader(this, resolved, listed.value.map((e) => e.name)));
	}

	async watch(_targets: unknown, _onChange: unknown, _context: Context): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "spoond can't watch files yet"));
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.#resolve(path);
		return this.#fileSh(resolved, `realpath -e -- ${q(resolved)}`, context);
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : err(info.error);
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		return this.#done(await this.#fileSh(resolved, `mkdir ${(options?.recursive ?? true) ? "-p " : ""}-- ${q(resolved)}`, context));
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
		return this.#done(await this.#fileSh(resolved, `rm ${flags === "" ? "" : `-${flags} `}-- ${q(resolved)}`, context));
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#fileSh("", `mktemp -d "\${TMPDIR:-/tmp}"/${q(prefix ?? "tmp-")}XXXXXX`, context).then(trimmed);
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const name = `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`;
		return this.#fileSh("", `d=$(mktemp -d "\${TMPDIR:-/tmp}/tmp-XXXXXX") && : > "$d"/${q(name)} && printf %s "$d"/${q(name)}`, context);
	}

	#done(result: Result<string, FileError>): Result<void, FileError> {
		return result.ok ? ok(undefined) : result;
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "Nothing to run"));
		const timeout = options?.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
			return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
		}
		const inheritEnv = options?.inheritEnv ?? true;
		const env = { ...(inheritEnv ? this.#shellEnv : {}), ...options?.env };
		const cwd = options?.cwd ? this.#resolve(options.cwd) : this.cwd;
		const cannotStart = `{ printf %s ${CANNOT_START} >&2; exit 127; }`;
		let script = `cd -- ${q(cwd)} 2>/dev/null || ${cannotStart}\n`;
		script +=
			typeof command === "string"
				? command
				: `command -v -- ${q(command[0]!)} >/dev/null 2>&1 || ${cannotStart}\nexec ${command.map(q).join(" ")}`;
		if (!inheritEnv) script = `exec env -i ${Object.entries(env).map(([k, v]) => q(`${k}=${v}`)).join(" ")} bash -c ${q(script)}`;
		// With a window, spoond may drop output's front past a cap well above it, so a chatty command can't fill the disk.
		const cap = options?.window === undefined ? undefined : Math.max(1024 * 1024, 4 * options.window.maxBytes);

		let jobId: string;
		try {
			const started = await this.#request("POST", "/exec", {
				body: JSON.stringify({
					cmd: script,
					background: true,
					retention_secs: JOB_RETENTION,
					...(inheritEnv ? { env } : {}),
					...(cap === undefined ? {} : { output_max_bytes: cap }),
				}),
				...(signal === undefined ? {} : { signal }),
			});
			if (started.status !== 202 && started.status !== 200) {
				const body = (await started.json().catch(() => undefined)) as { error?: string; code?: string } | undefined;
				// spawn_error: the job never started (spoond 3.11); anything else is spoond's, not the command's.
				const code = body?.code === "spawn_error" ? "spawn_error" : "unknown";
				return err(new ExecutionError(code, `spoond answered ${started.status}: ${body?.error ?? body?.code ?? ""}`.trim()));
			}
			jobId = ((await started.json()) as { job_id: string }).job_id;
		} catch (error) {
			if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		this.#running.add(jobId);
		const output = new JobOutput(this.#request, jobId, options, context);
		const deadline = timeout === undefined ? undefined : Date.now() + timeout * 1000;
		try {
			for (let polls = 1; ; polls++) {
				const remaining = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
				if (signal?.aborted) return err(await this.#stop(jobId, new ExecutionError("aborted", "aborted")));
				if (remaining <= 0) return err(await this.#stop(jobId, new ExecutionError("timeout", `timeout:${timeout}`)));
				const wait = Math.max(0, Math.min(polls, POLL_SECONDS, Math.floor(remaining / 1000)));
				const poll = AbortSignal.any([...(signal === undefined ? [] : [signal]), ...(deadline === undefined ? [] : [AbortSignal.timeout(remaining)])]);
				let job: Job;
				try {
					job = await this.#job(jobId, wait, poll);
					await output.drain();
				} catch (error) {
					if (poll.aborted) continue;
					if (error instanceof ExecutionError) return err(await this.#stop(jobId, error));
					throw error;
				}
				if (job.state === "lost") return err(new ExecutionError("unknown", "The sandbox restarted, and the command with it"));
				if (job.state !== "running") {
					const exitCode = job.exit_code ?? 128;
					if (output.cannotStart(exitCode)) return err(new ExecutionError("spawn_error", "No such directory or program"));
					output.flush();
					return ok({ exitCode });
				}
				if (wait === 0) await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 50)));
			}
		} catch (error) {
			if (error instanceof ExecutionError) return err(error);
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		} finally {
			this.#running.delete(jobId);
			void this.#request("DELETE", `/jobs/${jobId}`).then((r) => r.body?.cancel()).catch(() => {});
		}
	}

	async #job(jobId: string, wait: number, signal: AbortSignal): Promise<Job> {
		const response = await this.#request("GET", `/jobs/${jobId}?wait=${wait}`, { signal });
		if (!response.ok) throw new ExecutionError("unknown", `spoond answered ${response.status} following the command`);
		return ((await response.json()) as { job: Job }).job;
	}

	/** Stop a command: TERM, a moment to exit, then KILL. */
	async #stop(jobId: string, reason: ExecutionError): Promise<ExecutionError> {
		const signal = async (name: string) => (await this.#request("POST", `/jobs/${jobId}/signal`, { body: JSON.stringify({ signal: name }) })).body?.cancel();
		try {
			await signal("TERM");
			const job = await this.#job(jobId, 2, AbortSignal.timeout(5000));
			if (job.state === "running") await signal("KILL");
		} catch {}
		return reason;
	}

	async cleanup(_context: Context): Promise<void> {
		await Promise.all(
			[...this.#running].map((jobId) =>
				this.#request("POST", `/jobs/${jobId}/signal`, { body: JSON.stringify({ signal: "KILL" }) }).then((r) => r.body?.cancel()).catch(() => {}),
			),
		);
		this.#running.clear();
	}
}

/** A job's stdout and stderr, read by absolute offset as they grow, decoded and handed to `onOutput`. */
class JobOutput {
	readonly #request: SpoondRequest;
	readonly #jobId: string;
	readonly #options: ShellExecOptions | undefined;
	readonly #context: Context;
	readonly #streams = {
		stdout: { offset: 0, newlines: 0, decoder: new StreamDecoder() },
		stderr: { offset: 0, newlines: 0, decoder: new StreamDecoder() },
	};
	/** stderr held back while it could still be the cannot-start marker. */
	#held: string | undefined = "";

	constructor(request: SpoondRequest, jobId: string, options: ShellExecOptions | undefined, context: Context) {
		this.#request = request;
		this.#jobId = jobId;
		this.#options = options;
		this.#context = context;
	}

	async drain(): Promise<void> {
		for (const name of ["stdout", "stderr"] as const) {
			const stream = this.#streams[name];
			for (;;) {
				const response = await this.#request("GET", `/jobs/${this.#jobId}/output?stream=${name}&offset=${stream.offset}&limit=${OUTPUT_LIMIT}`);
				if (!response.ok) throw new ExecutionError("unknown", `spoond answered ${response.status} reading output`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				const start = Number(response.headers.get("x-output-offset") ?? stream.offset);
				let skipped: ShellOutputSkip | undefined;
				if (start > stream.offset) {
					const dropped = JSON.parse(response.headers.get("x-output-skipped") ?? "{}") as Skip;
					// Older spoonds don't say whether the dropped front ended a line (spoond-sgld); false then.
					skipped = {
						bytes: start - stream.offset,
						newlines: Math.max(0, (dropped.newlines ?? stream.newlines) - stream.newlines),
						endsWithNewline: dropped.ends_with_newline === true,
					};
					stream.newlines = dropped.newlines ?? stream.newlines;
					stream.decoder = new StreamDecoder();
				}
				if (bytes.length === 0) break;
				stream.offset = start + bytes.length;
				for (const byte of bytes) if (byte === 10) stream.newlines++;
				this.#deliver(name, stream.decoder.decode(bytes), skipped);
				if (bytes.length < OUTPUT_LIMIT) break;
			}
		}
	}

	/** Whether the command never started: our marker alone on stderr, exit 127. */
	cannotStart(exitCode: number): boolean {
		return exitCode === 127 && this.#held === CANNOT_START;
	}

	/** At the end: what was held back, and what the decoders still hold. */
	flush(): void {
		if (this.#held !== undefined && this.#held !== "") this.#emit("stderr", this.#held);
		this.#held = undefined;
		for (const name of ["stdout", "stderr"] as const) {
			const rest = this.#streams[name].decoder.decode();
			if (rest !== "") this.#emit(name, rest);
		}
	}

	#deliver(stream: "stdout" | "stderr", text: string, skipped: ShellOutputSkip | undefined): void {
		if (stream === "stderr" && this.#held !== undefined) {
			const held = this.#held + text;
			if (CANNOT_START.startsWith(held) && skipped === undefined) {
				this.#held = held;
				return;
			}
			this.#held = undefined;
			text = held;
		}
		this.#emit(stream, text, this.#options?.window === undefined ? undefined : skipped);
	}

	#emit(stream: "stdout" | "stderr", text: string, skipped?: ShellOutputSkip): void {
		if (text === "" || this.#options?.onOutput === undefined) return;
		try {
			this.#options.onOutput(text, this.#context, { stream, ...(skipped === undefined ? {} : { skipped }) });
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new ExecutionError("callback_error", cause.message, cause);
		}
	}
}

/** A file opened for positional reads: a hard link to it in the lease (or its path), read with ranged GETs. */
class RangeReader implements BinaryReader {
	readonly #env: SpoondRestEnv;
	readonly #path: string;
	readonly #at: string;
	readonly #linked: boolean;
	#closed = false;

	constructor(env: SpoondRestEnv, path: string, at: string, linked: boolean) {
		this.#env = env;
		this.#path = path;
		this.#at = at;
		this.#linked = linked;
	}

	#early(context: Context): Result<never, FileError> | undefined {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.#path));
		if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#path));
		return undefined;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const early = this.#early(context);
		if (early) return early;
		const info = await this.#env.infoOf(this.#at, posix.basename(this.#path), context);
		return info.ok ? ok({ ...info.value, path: this.#path }) : info;
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const early = this.#early(context);
		if (early) return early;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path));
		}
		try {
			return ok(await this.#env.readRange(this.#at, offset, length));
		} catch (error) {
			return err(error instanceof FileError ? error : new FileError("unknown", String(error), this.#path));
		}
	}

	async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
		const early = this.#early(context);
		if (early) return early;
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.#path));
		}
		for (let offset = 0; ; offset += READ_CHUNK) {
			const chunk = await this.read(offset, READ_CHUNK, context);
			if (!chunk.ok) return chunk;
			if (chunk.value.length > 0) scanner.push(chunk.value);
			if (chunk.value.length < READ_CHUNK) return ok(scanner.finish());
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#linked) await this.#env.removeQuietly(this.#at);
	}
}

/** A directory's entries in pages; each page looks again, so entries removed meanwhile are skipped. */
class PagedDirReader implements DirReader {
	readonly #env: SpoondRestEnv;
	readonly #path: string;
	#pending: string[];
	#closed = false;

	constructor(env: SpoondRestEnv, path: string, names: string[]) {
		this.#env = env;
		this.#path = path;
		this.#pending = names;
	}

	async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.#path));
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", this.#path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.#path));
		if (this.#pending.length === 0) return ok({ entries: [], done: true });
		const now = await this.#env.listDir(this.#path, context);
		if (!now.ok) return now;
		const present = new Map(now.value.map((e) => [e.name, e]));
		const entries: FileInfo[] = [];
		while (entries.length < maxEntries && this.#pending.length > 0) {
			const info = present.get(this.#pending.shift()!);
			if (info !== undefined) entries.push(info);
		}
		return ok({ entries, done: this.#pending.length === 0 });
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}
}

/** Lines of text read whole when opened. */
class LinesReader implements TextLineReader {
	readonly #path: string;
	#text: string | undefined;

	constructor(text: string, path: string) {
		this.#text = text;
		this.#path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.#path));
		if (this.#text === undefined) return err(new FileError("invalid", "Text line reader is closed", this.#path));
		if (this.#text === "") return ok(undefined);
		const newline = this.#text.indexOf("\n");
		if (newline === -1) {
			const text = this.#text;
			this.#text = "";
			return ok({ text, terminated: false });
		}
		const text = this.#text.slice(0, newline);
		this.#text = this.#text.slice(newline + 1);
		return ok({ text, terminated: true });
	}

	async close(_context: Context): Promise<void> {
		this.#text = undefined;
	}
}

/** `find -printf '%y\t%s\t%T@\t%f'`: a file, directory or symbolic link, or undefined for other kinds. */
function toInfo(row: string, dir: string): FileInfo | undefined {
	const [type, size, mtime] = row.split("\t", 3);
	const name = row.split("\t").slice(3).join("\t");
	const kind = type === "f" ? "file" : type === "d" ? "directory" : type === "l" ? "symlink" : undefined;
	if (kind === undefined) return undefined;
	return { name, path: posix.join(dir, name), kind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
}

/** A failed shell file operation as a `FileError`: our own `E:<code>`, else what coreutils said. */
/** spoond's stable error codes (3.11, spoond-wir9) for the file routes, as Pi's. */
const FILE_CODES: Record<string, FileErrorCode> = {
	ENOENT: "not_found",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	EACCES: "permission_denied",
	EINVAL: "invalid",
	EEXIST: "invalid",
	ENOTEMPTY: "invalid",
	EFBIG: "invalid",
};

/** A failed file route's answer as a `FileError`, by spoond's `code`; undefined from a spoond too old to say. */
async function spoondFileError(response: Response, path: string): Promise<FileError | undefined> {
	const body = (await response.json().catch(() => undefined)) as { error?: string; code?: string } | undefined;
	if (body?.code === undefined) return undefined;
	return new FileError(FILE_CODES[body.code] ?? "unknown", body.error ?? body.code, path);
}

function fileError(stderr: string, path: string): FileError {
	const own = /E:([a-z_]+)/.exec(stderr)?.[1];
	const message = stderr.trim() || "failed";
	if (own !== undefined) return new FileError(own as FileErrorCode, message, path);
	const code: FileErrorCode = /No such file/.test(stderr)
		? "not_found"
		: /Not a directory/.test(stderr)
			? "not_directory"
			: /Is a directory/.test(stderr)
				? "is_directory"
				: /Permission denied|Operation not permitted/.test(stderr)
					? "permission_denied"
					: /Invalid argument/.test(stderr)
						? "invalid"
						: "unknown";
	return new FileError(code, message, path);
}

function trimmed(result: Result<string, FileError>): Result<string, FileError> {
	return result.ok ? ok(result.value.trim()) : result;
}

function bytesOf(content: string | Uint8Array): Uint8Array<ArrayBuffer> {
	return typeof content === "string" ? new Uint8Array(Buffer.from(content, "utf8")) : new Uint8Array(content);
}

/** One shell word. */
function q(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
