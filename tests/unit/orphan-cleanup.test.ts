import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cleanupOrphanStagingFiles, OLS_TMP_PREFIX } from "../../src/filesystem/orphan-cleanup.js";

describe("Orphan Staging Cleanup", () => {
  let tempDir: string;
  let vaultRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "livesync-orphan-test-"));
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

  it("exports OLS_TMP_PREFIX as .ols-tmp-", () => {
    expect(OLS_TMP_PREFIX).toBe(".ols-tmp-");
  });

  it("cleans .ols-tmp-* files in root and subdirectories while preserving real files", async () => {
    // Create real files
    await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Note");
    await fs.mkdir(path.join(vaultRoot, "sub"), { recursive: true });
    await fs.writeFile(path.join(vaultRoot, "sub", "Child.md"), "# Child");
    await fs.writeFile(path.join(vaultRoot, ".gitignore"), "node_modules");

    // Create orphan staging files
    await fs.writeFile(path.join(vaultRoot, ".ols-tmp-12345"), "temp1");
    await fs.writeFile(path.join(vaultRoot, "sub", ".ols-tmp-67890"), "temp2");

    const cleaned = await cleanupOrphanStagingFiles(vaultRoot);
    expect(cleaned).toBe(2);

    // Staging files must be gone
    await expect(fs.access(path.join(vaultRoot, ".ols-tmp-12345"))).rejects.toThrow();
    await expect(fs.access(path.join(vaultRoot, "sub", ".ols-tmp-67890"))).rejects.toThrow();

    // Real user files and other dotfiles must remain
    expect(await fs.readFile(path.join(vaultRoot, "Note.md"), "utf-8")).toBe("# Note");
    expect(await fs.readFile(path.join(vaultRoot, "sub", "Child.md"), "utf-8")).toBe("# Child");
    expect(await fs.readFile(path.join(vaultRoot, ".gitignore"), "utf-8")).toBe("node_modules");
  });

  it("returns 0 and does not error on non-existent directory", async () => {
    const cleaned = await cleanupOrphanStagingFiles(path.join(tempDir, "nonexistent"));
    expect(cleaned).toBe(0);
  });
});
