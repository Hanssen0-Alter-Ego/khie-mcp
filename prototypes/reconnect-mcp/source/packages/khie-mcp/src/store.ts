import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BridgeError,
  type SecureStateStore,
  type WalletState,
} from "./state.js";

/** Local POSIX prototype adapter; use a KMS-backed transactional store remotely. */
export class FileSecureStateStore implements SecureStateStore {
  private constructor(
    private readonly directory: string,
    private readonly key: Buffer,
  ) {}

  static async open(directory: string, key: Buffer) {
    if (key.length !== 32) {
      throw new BridgeError("invalid_store_key");
    }
    const path = resolve(directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new BridgeError("unsafe_store_directory");
    }
    return new FileSecureStateStore(path, Buffer.from(key));
  }

  async create(state: WalletState) {
    const handle = randomUUID();
    await this.write(handle, state);
    return handle;
  }

  async withSession<T>(
    principal: string,
    handle: string,
    use: (state: WalletState, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        handle,
      )
    ) {
      throw new BridgeError("unknown_handle");
    }
    const lock = `${this.directory}/${handle}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BridgeError("session_busy");
      }
      throw error;
    }
    let quarantined = false;
    try {
      const state = await this.read(handle);
      if (state.principal !== principal) {
        throw new BridgeError("unknown_handle");
      }
      return await use(state, () => this.write(handle, state));
    } catch (error) {
      quarantined =
        error instanceof BridgeError &&
        error.code === "transport_cleanup_failed";
      throw error;
    } finally {
      if (!quarantined) {
        await rm(lock, { recursive: true });
      }
    }
  }

  private async read(handle: string): Promise<WalletState> {
    try {
      const file = await open(
        `${this.directory}/${handle}.sealed`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const bytes = await file.readFile();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(handle));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const state = JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString(),
        ) as WalletState;
        if (state.version !== 1) {
          throw new Error("Unsupported state");
        }
        return state;
      } finally {
        await file.close();
      }
    } catch {
      throw new BridgeError("unknown_handle");
    }
  }

  private async write(handle: string, state: WalletState) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(handle));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state)),
      cipher.final(),
    ]);
    const temp = `${this.directory}/${handle}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(
        Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, `${this.directory}/${handle}.sealed`);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
