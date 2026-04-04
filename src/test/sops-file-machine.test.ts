import * as assert from "assert";
import * as sinon from "sinon";
import { createActor, waitFor } from "xstate";
import {
  sopsFileMachine,
  type SopsFileIO,
  type SopsFileConfig,
  type SopsFileEmitted,
  type SopsFileLogger,
} from "../sops-file-machine.js";

const noopLog: SopsFileLogger = { info: () => {}, error: () => {} };

function mockIO(overrides?: Partial<SopsFileIO>): SopsFileIO {
  return {
    detect: sinon.stub().resolves(true),
    decrypt: sinon.stub().resolves("decrypted content"),
    encrypt: sinon.stub().resolves(),
    getEncryptedFileMtime: sinon.stub().resolves(1000),
    getLastReadMtime: sinon.stub().returns(1000),
    getEditorContent: sinon.stub().returns("editor content"),
    writeBuffer: sinon.stub(),
    clearBuffer: sinon.stub(),
    isTabOpen: sinon.stub().returns(false),
    ...overrides,
  };
}

const autoOpen: SopsFileConfig = { action: "auto-open", encryptedFileTab: "close" };
const prompt: SopsFileConfig = { action: "prompt", encryptedFileTab: "close" };
const doNothing: SopsFileConfig = { action: "do-nothing", encryptedFileTab: "close" };

function start(filePath: string, config: SopsFileConfig, io: SopsFileIO) {
  const actor = createActor(sopsFileMachine, {
    input: { filePath, config, io, log: noopLog },
  });
  const emitted: SopsFileEmitted[] = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  return { actor, emitted };
}

async function startDecrypted(ioOverrides?: Partial<SopsFileIO>) {
  const io = mockIO(ioOverrides);
  const { actor, emitted } = start("/test/secrets.sops.yaml", autoOpen, io);
  await waitFor(actor, (s) => s.value === "decrypted");
  return { actor, io, emitted };
}

/** Poll until an assertion passes (replaces vitest's vi.waitFor). */
async function pollUntil(fn: () => void, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastError;
}

/** Check if emitted array contains an event matching the given partial object. */
function assertEmitted(emitted: SopsFileEmitted[], partial: Partial<SopsFileEmitted>): void {
  const found = emitted.some((e) =>
    Object.entries(partial).every(
      ([k, v]) => (e as Record<string, unknown>)[k] === v,
    ),
  );
  assert.ok(
    found,
    `Expected emitted events to contain ${JSON.stringify(partial)}, got: ${JSON.stringify(emitted.map((e) => e.type))}`,
  );
}

suite("sopsFileMachine", () => {
  suite("detecting", () => {
    test("goes to done when not SOPS", async () => {
      const { actor } = start("/test/file.yaml", autoOpen, mockIO({ detect: sinon.stub().resolves(false) }));
      const snap = await waitFor(actor, (s) => s.value === "done");
      assert.strictEqual(snap.value, "done");
    });

    test("goes to done on detect error", async () => {
      const { actor } = start("/test/file.yaml", autoOpen, mockIO({
        detect: sinon.stub().rejects(new Error("detect boom")),
      }));
      const snap = await waitFor(actor, (s) => s.value === "done");
      assert.strictEqual(snap.context.error, "detect boom");
    });

    test("goes to encrypted when SOPS detected (do-nothing stays)", async () => {
      const { actor } = start("/test/file.sops.yaml", doNothing, mockIO());
      const snap = await waitFor(actor, (s) => s.value === "encrypted");
      assert.strictEqual(snap.value, "encrypted");
    });

    test("emits promptDecrypt when config is prompt", async () => {
      const { actor, emitted } = start("/test/file.sops.yaml", prompt, mockIO());
      await waitFor(actor, (s) => s.value === "encrypted");
      assertEmitted(emitted, { type: "promptDecrypt", filePath: "/test/file.sops.yaml" });
    });
  });

  suite("auto-open flow", () => {
    test("detecting -> encrypted -> decrypting -> decrypted", async () => {
      const io = mockIO();
      const { actor, emitted } = start("/test/secrets.sops.yaml", autoOpen, io);

      await waitFor(actor, (s) => s.value === "decrypted");
      assert.ok((io.decrypt as sinon.SinonStub).calledWith("/test/secrets.sops.yaml"));
      assert.ok((io.writeBuffer as sinon.SinonStub).called);
      assertEmitted(emitted, { type: "decrypted", filePath: "/test/secrets.sops.yaml" });
    });

    test("does not loop infinitely when decrypt fails, lands in decrypting.failed", async () => {
      let calls = 0;
      const io = mockIO({
        decrypt: sinon.stub().callsFake(async () => { calls++; throw new Error("no key"); }),
      });
      const { actor } = start("/test/secrets.sops.yaml", autoOpen, io);

      await pollUntil(() => {
        assert.ok(actor.getSnapshot().matches({ decrypting: "failed" }));
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(actor.getSnapshot().context.error, "no key");
    });

    test("can retry from decrypting.failed", async () => {
      const decryptStub = sinon.stub()
        .onFirstCall().rejects(new Error("no key"))
        .onSecondCall().resolves("decrypted content");
      const io = mockIO({ decrypt: decryptStub });
      const { actor, emitted } = start("/test/secrets.sops.yaml", autoOpen, io);

      await pollUntil(() => {
        assert.ok(actor.getSnapshot().matches({ decrypting: "failed" }));
      });

      actor.send({ type: "DECRYPT" });
      await waitFor(actor, (s) => s.value === "decrypted");
      assert.ok(decryptStub.calledTwice);
      assertEmitted(emitted, { type: "decrypted" });
    });
  });

  suite("manual decrypt", () => {
    test("waits for DECRYPT when do-nothing", async () => {
      const io = mockIO();
      const { actor } = start("/test/file.sops.yaml", doNothing, io);

      await waitFor(actor, (s) => s.value === "encrypted");
      assert.ok(!(io.decrypt as sinon.SinonStub).called);

      actor.send({ type: "DECRYPT" });
      await waitFor(actor, (s) => s.value === "decrypted");
      assert.ok((io.decrypt as sinon.SinonStub).called);
    });

    test("decrypt failure goes to decrypting.failed", async () => {
      const io = mockIO({ decrypt: sinon.stub().rejects(new Error("no key")) });
      const { actor, emitted } = start("/test/file.sops.yaml", doNothing, io);

      await waitFor(actor, (s) => s.value === "encrypted");
      actor.send({ type: "DECRYPT" });

      await pollUntil(() => {
        assertEmitted(emitted, { type: "decryptFailed", error: "no key" });
      });
      assert.ok(actor.getSnapshot().matches({ decrypting: "failed" }));
    });
  });

  suite("encrypting", () => {
    test("encrypts successfully", async () => {
      const { actor, io, emitted } = await startDecrypted();

      actor.send({ type: "ENCRYPT" });
      await pollUntil(() => {
        assertEmitted(emitted, { type: "encrypted" });
      });
      assert.ok((io.encrypt as sinon.SinonStub).calledWith("/test/secrets.sops.yaml", "editor content"));
      assert.ok((io.writeBuffer as sinon.SinonStub).called);
    });

    test("fails when no editor content", async () => {
      const { actor, emitted } = await startDecrypted({
        getEditorContent: sinon.stub().returns(undefined),
      });

      actor.send({ type: "ENCRYPT" });
      await pollUntil(() => {
        assertEmitted(emitted, { type: "encryptFailed", error: "No content to encrypt" });
      });
    });

    test("aborts on stale mtime", async () => {
      const { actor, emitted } = await startDecrypted({
        getLastReadMtime: sinon.stub().returns(1000),
        getEncryptedFileMtime: sinon.stub().resolves(2000),
      });

      actor.send({ type: "ENCRYPT" });
      await pollUntil(() => {
        assertEmitted(emitted, { type: "encryptAborted", reason: "stale" });
      });
      assert.strictEqual(actor.getSnapshot().value, "decrypted");
    });

    test("skips mtime check with overwrite: true", async () => {
      const { actor, io, emitted } = await startDecrypted({
        getLastReadMtime: sinon.stub().returns(1000),
        getEncryptedFileMtime: sinon.stub().resolves(2000),
      });

      actor.send({ type: "ENCRYPT", overwrite: true });
      await pollUntil(() => {
        assertEmitted(emitted, { type: "encrypted" });
      });
      assert.ok((io.encrypt as sinon.SinonStub).called);
    });

    test("emits encryptFailed on error", async () => {
      const { actor, emitted } = await startDecrypted({
        encrypt: sinon.stub().rejects(new Error("kms error")),
      });

      actor.send({ type: "ENCRYPT" });
      await pollUntil(() => {
        assertEmitted(emitted, { type: "encryptFailed", error: "kms error" });
      });
      assert.strictEqual(actor.getSnapshot().value, "decrypted");
    });
  });

  suite("tab close and idle", () => {
    test("DECRYPTED_TAB_CLOSED goes to done when encrypted tab is closed", async () => {
      const { actor, io } = await startDecrypted();
      // isTabOpen defaults to returning false (no encrypted tab open)
      actor.send({ type: "DECRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().status, "done");
      assert.ok((io.clearBuffer as sinon.SinonStub).calledWith("/test/secrets.sops.yaml"));
    });

    test("DECRYPTED_TAB_CLOSED goes to idle when encrypted tab is still open", async () => {
      const { actor, io } = await startDecrypted({
        isTabOpen: sinon.stub().callsFake((_path: string, scheme: string) => scheme === "file"),
      });
      actor.send({ type: "DECRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().value, "idle");
      assert.ok((io.clearBuffer as sinon.SinonStub).calledWith("/test/secrets.sops.yaml"));
    });

    test("from idle, DECRYPT re-decrypts", async () => {
      const { actor, emitted } = await startDecrypted({
        isTabOpen: sinon.stub().callsFake((_path: string, scheme: string) => scheme === "file"),
      });
      actor.send({ type: "DECRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().value, "idle");

      actor.send({ type: "DECRYPT" });
      await waitFor(actor, (s) => s.value === "decrypted");
      assertEmitted(emitted, { type: "decrypted" });
    });

    test("from idle, ENCRYPTED_TAB_CLOSED goes to done", async () => {
      const { actor } = await startDecrypted({
        isTabOpen: sinon.stub().callsFake((_path: string, scheme: string) => scheme === "file"),
      });
      actor.send({ type: "DECRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().value, "idle");

      actor.send({ type: "ENCRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().status, "done");
    });

    test("ENCRYPTED_TAB_CLOSED from encrypted goes to done", async () => {
      const { actor } = start("/test/file.sops.yaml", doNothing, mockIO());
      await waitFor(actor, (s) => s.value === "encrypted");

      actor.send({ type: "ENCRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().status, "done");
    });

    test("ENCRYPTED_TAB_CLOSED from decrypting.failed goes to done", async () => {
      const io = mockIO({ decrypt: sinon.stub().rejects(new Error("no key")) });
      const { actor } = start("/test/file.sops.yaml", doNothing, io);
      await waitFor(actor, (s) => s.value === "encrypted");
      actor.send({ type: "DECRYPT" });

      await pollUntil(() => {
        assert.ok(actor.getSnapshot().matches({ decrypting: "failed" }));
      });

      actor.send({ type: "ENCRYPTED_TAB_CLOSED" });
      assert.strictEqual(actor.getSnapshot().status, "done");
    });
  });

  suite("decrypted events", () => {
    test("REOPEN emits alreadyDecrypted", async () => {
      const { actor, emitted } = await startDecrypted();
      actor.send({ type: "REOPEN" });
      assert.strictEqual(actor.getSnapshot().value, "decrypted");
      assertEmitted(emitted, { type: "alreadyDecrypted", filePath: "/test/secrets.sops.yaml" });
    });
  });
});
