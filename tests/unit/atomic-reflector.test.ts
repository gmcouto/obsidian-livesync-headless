import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  installAtomically,
  ReadbackMismatchError,
} from "../../src/filesystem/atomic-reflector.js";

describe("Atomic Vault Reflector Unit Tests", () => {
  let tempDir: string;
  let vaultRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "livesync-reflector-test-"));
    vaultRoot = path.join(tempDir, "vault");
    await fs.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("installs a file atomically with exact matching bytes", async () => {
    const relativePath = "notes/Welcome.md";
    const bytes = new TextEncoder().encode("# Hello World\nWelcome to Obsidian!");

    await installAtomically(vaultRoot, relativePath, bytes);

    const destPath = path.join(vaultRoot, relativePath);
    const written = await fs.readFile(destPath);
    expect(new Uint8Array(written)).toEqual(bytes);
  });

  it("does not leave destination file if rename fails (crash-before-rename)", async () => {
    const relativePath = "notes/CrashTest.md";
    const bytes = new TextEncoder().encode("Important content");

    const failingRename = async (oldPath: string, _newPath: string) => {
      // Confirm the temporary file exists with .ols-tmp- prefix before rename
      expect(path.basename(oldPath)).toMatch(/^\.ols-tmp-[0-9a-f]{16}$/);
      throw new Error("Simulated crash before rename");
    };

    await expect(
      installAtomically(vaultRoot, relativePath, bytes, { renameFn: failingRename })
    ).rejects.toThrow("Simulated crash before rename");

    const destPath = path.join(vaultRoot, relativePath);
    await expect(fs.access(destPath)).rejects.toThrow();

    // Sibling directory was created, but dest does not exist
    const entries = await fs.readdir(path.join(vaultRoot, "notes"));
    expect(entries).not.toContain("CrashTest.md");
  });

  it("throws ReadbackMismatchError if read-back bytes do not match", async () => {
    const relativePath = "Corrupted.md";
    const bytes = new TextEncoder().encode("expected content");

    const corruptedReadFile = async (_p: string) => {
      return Buffer.from("corrupted content");
    };

    await expect(
      installAtomically(vaultRoot, relativePath, bytes, { readFileFn: corruptedReadFile })
    ).rejects.toThrow(ReadbackMismatchError);
  });

  it("rejects unsafe relative paths", async () => {
    const bytes = new TextEncoder().encode("bad");
    await expect(installAtomically(vaultRoot, "../escape.md", bytes)).rejects.toThrow(/Unsafe/);
    await expect(installAtomically(vaultRoot, "/absolute.md", bytes)).rejects.toThrow(/Unsafe/);
    await expect(installAtomically(vaultRoot, "C:\\windows.md", bytes)).rejects.toThrow(/Unsafe/);
    await expect(installAtomically(vaultRoot, "notes/../../bad.md", bytes)).rejects.toThrow(/Unsafe/);
  });
});
