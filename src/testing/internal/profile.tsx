import * as React from "react";
import type { Interaction } from "scheduler/tracing";
import { within, screen } from "@testing-library/dom";

import { TextEncoder, TextDecoder } from "util";

global.TextEncoder ??= TextEncoder;
// @ts-ignore
global.TextDecoder ??= TextDecoder;
const { JSDOM } = require("jsdom");

interface BaseRender {
  id: string;
  phase: "mount" | "update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  interactions: Set<Interaction>;
  count: number;
}

interface Render<Snapshot> extends BaseRender {
  snapshot: Snapshot;
  readonly domSnapshot: HTMLElement;
  // API design note:
  // could also be `typeof screen` instead of a function, but then we would get
  // `testing-library/prefer-screen-queries` warnings everywhere it is used
  withinDOM: () => typeof screen;
}

interface NextRenderOptions {
  timeout?: number;
  stackTrace?: string;
}

class RenderInstance<Snapshot> implements Render<Snapshot> {
  id: string;
  phase: "mount" | "update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  interactions: Set<Interaction>;
  count: number;

  constructor(
    baseRender: BaseRender,
    public snapshot: Snapshot,
    private stringifiedDOM: string | undefined
  ) {
    this.id = baseRender.id;
    this.phase = baseRender.phase;
    this.actualDuration = baseRender.actualDuration;
    this.baseDuration = baseRender.baseDuration;
    this.startTime = baseRender.startTime;
    this.commitTime = baseRender.commitTime;
    this.interactions = baseRender.interactions;
  }

  private _domSnapshot: HTMLElement | undefined;
  get domSnapshot() {
    if (!this._domSnapshot) {
      if (!this.stringifiedDOM) {
        throw new Error(
          "DOM snapshot is not available - please set the `snapshotDOM` option"
        );
      }
      const { document } = new JSDOM(this.stringifiedDOM).window;
      return document.body;
    }
    return this._domSnapshot;
  }

  get withinDOM() {
    const snapScreen = Object.assign(within(this.domSnapshot), {
      debug: (
        ...[dom = this.domSnapshot, ...rest]: Parameters<typeof screen.debug>
      ) => {
        screen.debug(dom, ...rest);
      },
      logTestingPlaygroundURL: (
        ...[dom = this.domSnapshot, ...rest]: Parameters<
          typeof screen.logTestingPlaygroundURL
        >
      ) => {
        screen.logTestingPlaygroundURL(dom, ...rest);
      },
    });
    return () => snapScreen;
  }
}

interface ProfiledComponent<Props, Snapshot> extends React.FC<Props> {
  renders: Array<
    Render<Snapshot> | { phase: "snapshotError"; count: number; error: unknown }
  >;
  takeRender(options?: NextRenderOptions): Promise<Render<Snapshot>>;
  getCurrentRender(): Render<Snapshot>;
  waitForRenderCount(count: number): Promise<void>;
  waitForNextRender(options?: NextRenderOptions): Promise<Render<Snapshot>>;
}

/**
 * @internal Should not be exported by the library.
 */
export function profile<
  Props extends React.JSX.IntrinsicAttributes,
  Snapshot = void,
>({
  Component,
  takeSnapshot,
  snapshotDOM = false,
}: {
  Component: React.ComponentType<Props>;
  takeSnapshot?: (render: BaseRender) => Snapshot;
  snapshotDOM?: boolean;
}) {
  let currentRender: Render<Snapshot> | undefined;
  let nextRender: Promise<Render<Snapshot>> | undefined;
  let resolveNextRender: ((render: Render<Snapshot>) => void) | undefined;
  let rejectNextRender: ((error: unknown) => void) | undefined;
  const onRender: React.ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
    interactions
  ) => {
    const baseRender = {
      id,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
      interactions,
      count: Profiled.renders.length + 1,
      snapshot: undefined,
    };
    try {
      /*
       * The `takeSnapshot` function could contain `expect` calls that throw
       * `JestAssertionError`s - but we are still inside of React, where errors
       * might be swallowed.
       * So we record them and re-throw them in `takeRender`
       * Additionally, we reject the `waitForNextRender` promise.
       */
      const snapshot = takeSnapshot?.(baseRender) as Snapshot;
      const domSnapshot = snapshotDOM
        ? window.document.body.innerHTML
        : undefined;
      const render = new RenderInstance(baseRender, snapshot, domSnapshot);
      // eslint-disable-next-line testing-library/render-result-naming-convention
      currentRender = render;
      Profiled.renders.push(render);
      const resolve = resolveNextRender;
      nextRender = resolveNextRender = rejectNextRender = undefined;
      resolve?.(render);
    } catch (error) {
      Profiled.renders.push({
        phase: "snapshotError",
        count: Profiled.renders.length,
        error,
      });
      const reject = rejectNextRender;
      nextRender = resolveNextRender = rejectNextRender = undefined;
      reject?.(error);
    }
  };

  let iteratorPosition = 0;
  const Profiled: ProfiledComponent<Props, Snapshot> = Object.assign(
    (props: Props) => (
      <React.Profiler id="test" onRender={onRender}>
        <Component {...props} />
      </React.Profiler>
    ),
    {
      renders: new Array<
        | Render<Snapshot>
        | { phase: "snapshotError"; count: number; error: unknown }
      >(),
      async takeRender(options: NextRenderOptions = {}) {
        try {
          if (iteratorPosition < Profiled.renders.length) {
            const render = Profiled.renders[iteratorPosition];
            if (render.phase === "snapshotError") {
              throw render.error;
            }
            return render;
          }
          return Profiled.waitForNextRender({
            stackTrace: captureStackTrace(Profiled.takeRender),
            ...options,
          });
        } finally {
          iteratorPosition++;
        }
      },
      getCurrentRender() {
        if (!currentRender) {
          throw new Error("Has not been rendered yet!");
        }
        return currentRender;
      },
      async waitForRenderCount(count: number) {
        while (Profiled.renders.length < count) {
          await Profiled.takeRender();
        }
      },
      waitForNextRender({
        timeout = 1000,
        // capture the stack trace here so its stack trace is as close to the calling code as possible
        stackTrace = captureStackTrace(Profiled.waitForNextRender),
      }: NextRenderOptions = {}) {
        if (!nextRender) {
          nextRender = Promise.race<Render<Snapshot>>([
            new Promise<Render<Snapshot>>((resolve, reject) => {
              resolveNextRender = resolve;
              rejectNextRender = reject;
            }),
            new Promise<Render<Snapshot>>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    applyStackTrace(
                      new Error("Exceeded timeout waiting for next render."),
                      stackTrace
                    )
                  ),
                timeout
              )
            ),
          ]);
        }
        return nextRender;
      },
    }
  );
  return Profiled;
}

function captureStackTrace(callingFunction?: () => {}) {
  let { stack = "" } = new Error("");
  if (
    callingFunction &&
    callingFunction.name &&
    stack.includes(callingFunction.name)
  ) {
    const lines = stack.split("\n");

    stack = lines
      .slice(lines.findIndex((line) => line.includes(callingFunction.name)))
      .join("\n");
  }

  return stack;
}

function applyStackTrace(error: Error, stackTrace: string) {
  error.stack = error.message + "\n" + stackTrace;
  return error;
}
