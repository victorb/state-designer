import {
  last,
  castArray,
  trimEnd,
  isFunction,
  uniqueId,
  isUndefined,
} from "lodash"
import { produce, enableAllPlugins, setAutoFreeze } from "immer"

import { createEventChain } from "./createEventChain"
import * as S from "./types"
import * as StateTree from "./stateTree"
import { getStateTreeFromDesign } from "./getStateTreeFromDesign"

enableAllPlugins()
setAutoFreeze(false)

type ReturnedValues<TD, TV extends Record<string, S.Value<TD>>> = {
  [key in keyof TV]: ReturnType<TV[key]>
}

/* -------------------------------------------------- */
/*                Create State Designer               */
/* -------------------------------------------------- */

/**
 * Create a new state from a designuration object.
 * @param design
 * @public
 */
export function createState<
  D,
  R extends Record<string, S.Result<D>>,
  C extends Record<string, S.Condition<D>>,
  A extends Record<string, S.Action<D>>,
  Y extends Record<string, S.Async<D>>,
  T extends Record<string, S.Time<D>>,
  V extends Record<string, S.Value<D>>
>(
  design: S.Design<D, R, C, A, Y, T, V>
): S.DesignedState<
  D,
  {
    [key in keyof V]: ReturnType<V[key]>
  }
> {
  /* ------------------ Mutable Data ------------------ */

  type Core = S.DesignedState<D, ReturnedValues<D, V>>

  // Update (internal update state)

  /* ------------------ Subscriptions ----------------- */

  // A set of subscription callbacks. The subscribe function
  // adds a callback to the set; unsubscribe removes it.
  const subscribers = new Set<S.SubscriberFn<Core>>([])

  /**
   * Subscribe a callback to this state's updates. On each update, the state
   * will call the callback with the state's new update.
   * @param callbackFn
   */
  function subscribe(callbackFn: S.SubscriberFn<Core>) {
    subscribers.add(callbackFn)
  }

  /**
   * Unsubscribe a callback from the state. The callback will no longer be
   * called when the state changes.
   * @param callbackFn
   */
  function unsubscribe(callbackFn: S.SubscriberFn<Core>) {
    if (subscribers.has(callbackFn)) {
      subscribers.delete(callbackFn)
    }

    // TODO: Prevent persistant intervals (in a smarter way)
    /* In some cases, intervals may persist past reloads, or when a 
    state is no longer needed. This solution is too blunt though: I can 
    imagine users wanting to keep a state's time ticking even when
    components that depend on it are unmounted. Public method for
    pause and resume? Activities with cleanup? */
    if (subscribers.size === 0) {
      StateTree.recursivelyEndStateIntervals(core.stateTree)
    }
  }

  // Call each subscriber callback with the state's current update
  function notifySubscribers() {
    core.values = getValues(core.data, design.values)
    core.active = StateTree.getActiveStates(core.stateTree)
    subscribers.forEach((subscriber) => subscriber(core))
  }

  /* --------------------- Updates -------------------- */

  // Run eve nt handler that updates the global `updates` object,
  // useful for (more or less) synchronous events
  function runEventHandlerChain(
    eventHandler: S.EventHandler<D>,
    payload: any = undefined,
    result: any = undefined
  ) {
    const outcome = createEventChain<D>({
      data: core.data,
      result,
      payload,
      handler: eventHandler,
      onAsyncUpdate: (update) => {
        core.data = update.data

        if (update.shouldNotify) {
          notifySubscribers()
        }

        if (update.pendingSend) {
          const { event, payload } = update.pendingSend
          send(event, payload)
        }

        if (update.pendingTransition) {
          runTransition(update.pendingTransition)
        }
      },
      onRefreshDataAfterWait: () => core.data,
    })

    core.data = outcome.data

    if (outcome.pendingSend) {
      const { event, payload } = outcome.pendingSend
      send(event, payload)
    }

    if (outcome.pendingTransition) {
      runTransition(outcome.pendingTransition)
    }

    return {
      shouldHalt: outcome.shouldBreak,
      shouldNotify: outcome.shouldNotify,
    }

    // return runEventHandler(state, eventHandler, payload, result)
  }

  // Try to run an event on a state. If active, it will run the corresponding
  // event, if it has one; and, so long as there hasn't been a transition,
  // will run its onEvent event, if it has one. If still no transition has
  // occurred, it will move to try its child states.
  function handleEventOnState(
    state: S.State<D, V>,
    sent: S.Event
  ): { shouldHalt: boolean; shouldNotify: boolean } {
    const record = { shouldHalt: false, shouldNotify: false }

    if (state.active) {
      const activeChildren = Object.values(state.states).filter(
        (state) => state.active
      )

      const eventHandler = state.on[sent.event]

      // Run event handler, if present
      if (!isUndefined(eventHandler)) {
        const outcome = runEventHandlerChain(
          eventHandler,
          sent.payload,
          undefined
        )

        if (outcome.shouldNotify) {
          record.shouldNotify = true
        }

        if (outcome.shouldHalt) {
          record.shouldNotify = true
          record.shouldHalt = true
          return record
        }
      }

      // Run onEvent, if present
      if (!isUndefined(state.onEvent)) {
        const outcome = runEventHandlerChain(
          state.onEvent,
          sent.payload,
          undefined
        )

        if (outcome.shouldNotify) {
          record.shouldNotify = true
        }

        if (outcome.shouldHalt) {
          record.shouldNotify = true
          record.shouldHalt = true
          return record
        }
      }
      // Run event on states
      for (let childState of activeChildren) {
        const outcome = handleEventOnState(childState, sent)

        if (outcome.shouldNotify) {
          record.shouldNotify = true
        }

        if (outcome.shouldHalt) {
          record.shouldNotify = true
          record.shouldHalt = true
          return record
        }
      }
    }

    return record
  }

  function runTransition(
    path: string,
    payload: any = undefined,
    result: any = undefined
  ) {
    // Is this a restore transition?

    const isPreviousTransition = path.endsWith(".previous")
    const isRestoreTransition = path.endsWith(".restore")

    if (isPreviousTransition) {
      path = trimEnd(path, ".previous")
    }

    if (isRestoreTransition) {
      path = trimEnd(path, ".restore")
    }

    // Get all states from the tree that match the target
    const targets = StateTree.findTransitionTargets(core.stateTree, path)

    // Get the deepest matching target state
    const target = last(targets)

    if (isUndefined(target)) {
      if (__DEV__) {
        throw Error("No state with that path in the tree!")
      } else {
        return
      }
    }

    // Get the path of state names to the target state
    const pathDown = target.path.split(".").slice(1)

    // Get an array of states that are currently active
    const beforeActive = StateTree.getActiveStates(core.stateTree)

    // Deactivate the whole state tree
    StateTree.deactivateState(core.stateTree)

    // Update the initial states across the entire state tree.
    StateTree.setIntitialStates(core.stateTree, payload, core.data)

    // Use the path to activate the tree again
    StateTree.activateState(
      core.stateTree,
      pathDown,
      beforeActive,
      isPreviousTransition || isRestoreTransition,
      isRestoreTransition
    )

    // Get an array of states that are now active
    const afterActive = StateTree.getActiveStates(core.stateTree)

    // Get an array of states that are no longer active
    const deactivatedStates = beforeActive.filter(
      (state) => !afterActive.includes(state)
    )

    // Get an array of states that have become active
    const newlyActivatedStates = afterActive.filter(
      (state) => !beforeActive.includes(state)
    )

    // Deactivated States
    // - clear any interval
    // - handle onExit events
    // - bail if we've transitioned

    deactivatedStates.forEach((state) => {
      StateTree.endStateIntervals(state)
    })

    for (let state of deactivatedStates) {
      const { onExit } = state

      if (!isUndefined(onExit)) {
        const outcome = runEventHandlerChain(onExit, payload, result)
        if (outcome.shouldHalt) return
      }
    }

    // Activated States
    // - set any repeat interval
    // - handle onEnter events
    // - bail if we've transitioned

    for (let state of newlyActivatedStates) {
      const { async, repeat, onEnter } = state

      if (!isUndefined(repeat)) {
        const { onRepeat, delay } = repeat

        let now = performance.now()
        let lastTime: number | undefined = undefined
        let elapsed = 0
        let realInterval = 0

        if (delay === undefined) {
          // Run on every animation frame
          const loop = (ms: number) => {
            if (isUndefined(lastTime)) {
              lastTime = ms
            }

            realInterval = ms - lastTime
            elapsed += realInterval

            lastTime = ms

            const outcome = runEventHandlerChain(onRepeat, payload, {
              interval: realInterval,
              elapsed,
            })

            if (outcome.shouldNotify) {
              notifySubscribers()
            }

            state.times.animationFrame = requestAnimationFrame(loop)
          }

          state.times.animationFrame = requestAnimationFrame(loop)
        } else {
          // Run on provided delay amount
          let lastTime = performance.now()

          const s = delay(core.data, payload, result)

          state.times.interval = setInterval(() => {
            now = performance.now()
            realInterval = now - lastTime
            elapsed += realInterval
            lastTime = now

            const outcome = runEventHandlerChain(onRepeat, payload, {
              interval: realInterval,
              elapsed,
            })

            if (outcome.shouldNotify) {
              notifySubscribers()
            }
          }, Math.max(1 / 60, s * 1000))
        }
      }

      if (!isUndefined(onEnter)) {
        const onEnterRecord = runEventHandlerChain(onEnter, payload, result)
        if (onEnterRecord.shouldHalt) {
          return
        }
      }

      if (!isUndefined(async)) {
        async.await(core.data, payload, result).then(
          (resolved) => {
            const localUpdate = runEventHandlerChain(
              async.onResolve,
              payload,
              resolved
            )

            if (localUpdate.shouldNotify) notifySubscribers()
          },
          (rejected) => {
            if (!isUndefined(async.onReject)) {
              const localUpdate = runEventHandlerChain(
                async.onReject,
                payload,
                rejected
              )

              if (localUpdate.shouldNotify) notifySubscribers()
            }
          }
        )
      }
    }

    return
  }

  /* -------------- Sent Event Processing ------------- */

  const sendQueue: S.Event[] = []

  function processSendQueue(): Core {
    const next = sendQueue.shift()

    if (isUndefined(next)) {
      return core
    } else {
      // Handle the event and set the current handleEventOnState
      // promise, which will hold any additional sent events
      const { shouldNotify } = handleEventOnState(core.stateTree, next)

      // Notify subscribers, if we should
      if (shouldNotify) {
        notifySubscribers()
      }

      // Then process the next sent event
      return processSendQueue()
    }
  }

  /* ----------------- Public Methods ----------------- */

  /**
   * Subscribe a callback function to the state's updates. Each time
   * the state updates (due to a successful transition or action), the
   * state will call the callback with its new update. This function
   * returns a second callback that will unsubscribe the callback.
   * @param callbackFn
   * @public
   * @example
   * const state = createState({ ... })
   * const cancelUpdates = state.onUpdate((update) => { ... })
   * if (allDone) cancelUpdates()
   *
   */
  function onUpdate(callbackFn: S.SubscriberFn<Core>) {
    subscribe(callbackFn)
    return () => unsubscribe(callbackFn)
  }

  /**
   * Get an update from the current state without subscribing.
   * @param callbackFn
   * @public
   */
  function getUpdate(callbackFn: S.SubscriberFn<Core>) {
    core.active = StateTree.getActiveStates(core.stateTree)
    callbackFn(core)
  }

  /**
   * Send an event to the state machine
   * @param eventName The name of the event
   * @param payload A payload of any type
   * @public
   */
  function send(eventName: string, payload?: any): Core {
    sendQueue.push({ event: eventName, payload })
    return processSendQueue()
  }

  /**
   * Accepts one or more paths and returns true if the state tree has matching active states for every path.
   * @param paths The paths to check
   * @public
   * @example
   * state.isIn("playing")
   * state.isIn("playing.paused")
   * state.isIn("on", "stopped") // true if BOTH states are active
   *
   */
  function isIn(path: string): boolean
  function isIn(...paths: string[]): boolean {
    return castArray(paths)
      .map((path) => (path.startsWith(".") ? path : "." + path))
      .every(
        (path) =>
          core.active.find((state) => state.path.endsWith(path)) !== undefined
      )
  }

  /**
   * Accepts one or more paths and returns true if the state tree has matching active states for any path.
   * @param paths The paths to check
   * @public
   * @example
   * state.isIn("playing")
   * state.isIn("playing.paused")
   * state.isIn("on", "stopped") // true if EITHER state is active
   *
   */
  function isInAny(path: string): boolean
  function isInAny(...paths: string[]): boolean {
    return castArray(paths)
      .map((path) => (path.startsWith(".") ? path : "." + path))
      .some(
        (path) =>
          core.active.find((state) => state.path.endsWith(path)) !== undefined
      )
  }

  /**
   * Return true if the event exists and would pass its conditions, given the current state and payload.
   * @param eventName The name of the event
   * @param payload A payload of any type
   * @public
   */
  function can(eventName: string, payload?: any, result?: any): boolean {
    return !isUndefined(
      core.active.find((state) => {
        const eventHandler = state.on[eventName]

        if (!isUndefined(eventHandler)) {
          for (let item of eventHandler) {
            // Result

            result = undefined

            for (let resu of item.get) {
              result = resu(core.data as D, payload, result)
            }

            // Conditions

            let passedConditions = true

            if (passedConditions && item.if.length > 0) {
              passedConditions = item.if.every((cond) =>
                cond(core.data, payload, result)
              )
            }

            if (passedConditions && item.unless.length > 0) {
              passedConditions = item.unless.every(
                (cond) => !cond(core.data, payload, result)
              )
            }

            if (passedConditions && item.ifAny.length > 0) {
              passedConditions = item.ifAny.some((cond) =>
                cond(core.data, payload, result)
              )
            }

            if (passedConditions) return true
          }
        }

        return false
      })
    )
  }

  /**
   * Get certain values when certain states are active. Contains a reducer to control how values are merged when multiple states are open.
   * @param paths An object with paths as keys and a value to include if this path is active.
   * @param reducer (optional) A function that will take all values from active paths and return an output.
   * @param initial (optional) The reducer's initial value.
   * @public
   */
  function whenIn<T = any>(
    paths: Record<string, any>,
    reducer: "value" | "array" | S.Reducer<T> = "value",
    initialValue?: any
  ): T {
    const entries: [string, any][] = []

    Object.entries(paths).forEach(([key, value]) => {
      let v = isFunction(value) ? value() : value
      if (key === "root") {
        entries.push([key, v])
      } else {
        if (
          core.active.find((v) => {
            let safeKey = key.startsWith(".") ? key : "." + key
            return v.path.endsWith(safeKey)
          })
        ) {
          entries.push([key, v])
        }
      }
    })

    if (entries.length === 0) {
      if (!isUndefined(paths.default)) {
        entries.push(["default", paths.default])
      }
    }

    let returnValue: any
    let rdcr: S.Reducer<T>

    if (reducer === "array") {
      returnValue = []
      rdcr = (a, [_, v]) => [...a, v] as any
    } else if (reducer === "value") {
      returnValue = undefined
      rdcr = (_, [__, v]) => v
    } else {
      returnValue = initialValue
      rdcr = reducer
    }

    entries.forEach(
      (entry, i) => (returnValue = rdcr(returnValue, entry, i, entries))
    )

    return returnValue
  }

  /**
   * Get the original design object (for debugging, mostly)
   * @public
   */
  function getDesign() {
    return design
  }

  /**
   * Create a new state from this state's original design
   * @public
   */
  function clone() {
    return createState(design)
  }

  /* --------------------- Kickoff -------------------- */

  const id = "#" + (isUndefined(design.id) ? `state_${uniqueId()}` : design.id)

  const ___stateTree = getStateTreeFromDesign(design, id)

  const core: Core = {
    id,
    data: produce(design.data, (d) => d) as D,
    active: StateTree.getActiveStates(___stateTree),
    stateTree: ___stateTree,
    send,
    isIn,
    isInAny,
    can,
    whenIn,
    getDesign,
    onUpdate,
    getUpdate,
    clone,
    values: getValues(design.data as D, design.values),
  }

  // Deactivate the tree, then activate it again to set initial active states.
  StateTree.deactivateState(core.stateTree)
  runTransition("root") // Will onEnter events matter?
  core.values = getValues(core.data, design.values)
  core.active = StateTree.getActiveStates(core.stateTree)

  return core
}

/* -------------------------------------------------- */
/*                        Pure                        */
/* -------------------------------------------------- */

/**
 * Hideously compute values based on the current data.
 * @param data The current data state.
 */
function getValues<D, V extends Record<string, S.Value<D>>>(
  data: D,
  values: V | undefined
): S.Values<D, V> {
  return Object.entries(values || {}).reduce<S.Values<D, V>>(
    (acc, [key, fn]) => {
      acc[key as keyof V] = fn(data as D)
      return acc
    },
    {} as S.Values<D, V>
  )
}