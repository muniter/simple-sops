import { setup, assign, emit, fromPromise, fromCallback } from "xstate";

export interface SopsFileConfig {
  action: "auto-open" | "prompt" | "do-nothing";
  encryptedFileTab: "close" | "keep";
}

export interface SopsFileLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface SopsFileIO {
  detect: (filePath: string) => Promise<boolean>;
  decrypt: (filePath: string) => Promise<string>;
  encrypt: (filePath: string, content: string) => Promise<void>;
  /** Get the current mtime of the real file on disk. */
  getEncryptedFileMtime: (filePath: string) => Promise<number | undefined>;
  /** Get the mtime we last saw when reading/writing the file. */
  getLastReadMtime: (filePath: string) => number | undefined;
  getEditorContent: (filePath: string) => string | undefined;
  writeBuffer: (filePath: string, data: Uint8Array, mtime: number | undefined) => void;
  clearBuffer: (filePath: string) => void;
}

export interface SopsFileContext {
  filePath: string;
  config: SopsFileConfig;
  io: SopsFileIO;
  log: SopsFileLogger;
  error: string | undefined;
}

export type SopsFileEvent =
  | { type: "DETECTED_SOPS" }
  | { type: "DETECTED_NOT_SOPS" }
  | { type: "DETECT_ERROR"; error: string }
  | { type: "DECRYPT" }
  | { type: "ENCRYPT"; overwrite?: boolean }
  | { type: "ENCRYPT_SUCCESS" }
  | { type: "ENCRYPT_ABORTED"; reason: string }
  | { type: "ENCRYPT_FAILED"; error: string }
  | { type: "REOPEN" }
  | { type: "CLOSE" };

export type SopsFileEmitted =
  | { type: "decrypted"; filePath: string; config: SopsFileConfig }
  | { type: "decryptFailed"; filePath: string; error: string }
  | { type: "encrypted"; filePath: string }
  | { type: "encryptAborted"; filePath: string; reason: string }
  | { type: "encryptFailed"; filePath: string; error: string }
  | { type: "promptDecrypt"; filePath: string }
  | { type: "alreadyDecrypted"; filePath: string };

export type SopsFileInput = {
  filePath: string;
  config: SopsFileConfig;
  io: SopsFileIO;
  log: SopsFileLogger;
};

export const sopsFileMachine = setup({
  types: {
    context: {} as SopsFileContext,
    events: {} as SopsFileEvent,
    input: {} as SopsFileInput,
    emitted: {} as SopsFileEmitted,
  },
  actors: {
    detect: fromCallback<
      { type: "DETECTED_SOPS" } | { type: "DETECTED_NOT_SOPS" } | { type: "DETECT_ERROR"; error: string },
      { io: SopsFileIO; filePath: string }
    >(({ sendBack, input }) => {
      void input.io.detect(input.filePath).then(
        (isSops) =>
          sendBack(isSops ? { type: "DETECTED_SOPS" } : { type: "DETECTED_NOT_SOPS" }),
        (err) =>
          sendBack({
            type: "DETECT_ERROR",
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }),

    decrypt: fromPromise(
      async ({ input }: { input: { io: SopsFileIO; log: SopsFileLogger; filePath: string } }) => {
        input.log.info(`decrypt: ${input.filePath}`);
        const plaintext = await input.io.decrypt(input.filePath);

        const data = new TextEncoder().encode(plaintext);
        const mtime = await input.io.getEncryptedFileMtime(input.filePath);
        input.io.writeBuffer(input.filePath, data, mtime);
        input.log.info(`decrypt: cached ${data.byteLength} bytes`);
      },
    ),

    encrypt: fromCallback<
      | { type: "ENCRYPT_SUCCESS" }
      | { type: "ENCRYPT_ABORTED"; reason: string }
      | { type: "ENCRYPT_FAILED"; error: string },
      { io: SopsFileIO; filePath: string; overwrite: boolean }
    >(({ sendBack, input }) => {
      void (async () => {
        const { io, filePath, overwrite } = input;

        const content = io.getEditorContent(filePath);
        if (content === undefined || content.trim() === "") {
          sendBack({ type: "ENCRYPT_FAILED", error: "No content to encrypt" });
          return;
        }

        if (!overwrite) {
          const savedMtime = io.getLastReadMtime(filePath);
          const currentMtime = await io.getEncryptedFileMtime(filePath);
          if (
            savedMtime !== undefined &&
            currentMtime !== undefined &&
            savedMtime !== currentMtime
          ) {
            sendBack({ type: "ENCRYPT_ABORTED", reason: "stale" });
            return;
          }
        }

        try {
          await io.encrypt(filePath, content);
          const mtime = await io.getEncryptedFileMtime(filePath);
          const data = new TextEncoder().encode(content);
          io.writeBuffer(filePath, data, mtime);
          sendBack({ type: "ENCRYPT_SUCCESS" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendBack({ type: "ENCRYPT_FAILED", error: message });
        }
      })();
    }),
  },
  guards: {
    isAutoOpen: ({ context }) => context.config.action === "auto-open",
    isPrompt: ({ context }) => context.config.action === "prompt",
  },
}).createMachine({
  id: "sopsFile",
  context: ({ input }) => ({
    filePath: input.filePath,
    config: input.config,
    io: input.io,
    log: input.log,
    error: undefined,
  }),
  initial: "detecting",
  states: {
    detecting: {
      invoke: {
        src: "detect",
        input: ({ context }) => ({ io: context.io, filePath: context.filePath }),
      },
      on: {
        DETECTED_SOPS: [
          {
            guard: "isPrompt",
            target: "encrypted",
            actions: emit(({ context }) => ({
              type: "promptDecrypt" as const,
              filePath: context.filePath,
            })),
          },
          { target: "encrypted" },
        ],
        DETECTED_NOT_SOPS: "done",
        DETECT_ERROR: {
          target: "done",
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },

    encrypted: {
      always: {
        guard: "isAutoOpen",
        target: "decrypting",
      },
      on: {
        DECRYPT: "decrypting",
        CLOSE: "done",
      },
    },

    decrypting: {
      initial: "active",
      states: {
        active: {
          invoke: {
            src: "decrypt",
            input: ({ context }) => ({ io: context.io, log: context.log, filePath: context.filePath }),
            onDone: {
              target: "#sopsFile.decrypted",
              actions: [
                assign({ error: undefined }),
                emit(({ context }) => ({
                  type: "decrypted" as const,
                  filePath: context.filePath,
                  config: context.config,
                })),
              ],
            },
            onError: {
              target: "failed",
              actions: [
                assign({
                  error: ({ event }) =>
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
                emit(({ context, event }) => ({
                  type: "decryptFailed" as const,
                  filePath: context.filePath,
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                })),
              ],
            },
          },
        },
        failed: {
          on: {
            DECRYPT: "active",
            CLOSE: "#sopsFile.done",
          },
        },
      },
    },

    decrypted: {
      on: {
        ENCRYPT: "encrypting",
        CLOSE: {
          target: "done",
          actions: ({ context }) => context.io.clearBuffer(context.filePath),
        },
        REOPEN: {
          actions: emit(({ context }) => ({
            type: "alreadyDecrypted" as const,
            filePath: context.filePath,
          })),
        },
      },
    },

    encrypting: {
      invoke: {
        src: "encrypt",
        input: ({ context, event }) => ({
          io: context.io,
          filePath: context.filePath,
          overwrite: event.type === "ENCRYPT" && event.overwrite === true,
        }),
      },
      on: {
        ENCRYPT_SUCCESS: {
          target: "decrypted",
          actions: [
            assign({ error: undefined }),
            emit(({ context }) => ({
              type: "encrypted" as const,
              filePath: context.filePath,
            })),
          ],
        },
        ENCRYPT_ABORTED: {
          target: "decrypted",
          actions: [
            assign({ error: undefined }),
            emit(({ context, event }) => ({
              type: "encryptAborted" as const,
              filePath: context.filePath,
              reason: event.reason,
            })),
          ],
        },
        ENCRYPT_FAILED: {
          target: "decrypted",
          actions: [
            assign({ error: ({ event }) => event.error }),
            emit(({ context, event }) => ({
              type: "encryptFailed" as const,
              filePath: context.filePath,
              error: event.error,
            })),
          ],
        },
      },
    },

    done: {
      type: "final",
    },
  },
});
