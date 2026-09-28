/** 面向宿主的简短运行状态；不包含模型思考、工具原始参数或完整结果。 */
export interface AgentActivity {
  event: string;
  preview: string;
  tool?: string;
}

/** 单次通用 Agent 执行上下文；结果可逐次输出，不限定业务结构。 */
export interface AgentExecutionContext<TInput, TOutput> {
  runId: string;
  input: TInput;
  signal: AbortSignal;
  assertActive(): void;
  emit(result: TOutput): Promise<void>;
  reportActivity?(activity: AgentActivity): void;
}

/** 一个独立能力定义，输入校验和实际执行由能力自身负责。 */
export interface AgentDefinition<TInput, TOutput> {
  type: string;
  description: string;
  parseInput(value: unknown): TInput;
  run(context: AgentExecutionContext<TInput, TOutput>): Promise<void>;
}

type ExecutionHost = Omit<AgentExecutionContext<unknown, unknown>, 'input'>;

/** 注册时通过闭包保留各能力的输入和输出类型。 */
interface RegisteredAgent {
  description: string;
  execute(input: unknown, context: ExecutionHost): Promise<void>;
}

/** 中止立即结束等待；已启动操作自行遵循共享信号，后续输出仍受执行门禁保护。 */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 通用能力注册与执行，不包含任何默认业务、传输协议或存储实现。 */
export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  /** 注册具备独立输入/输出类型的能力，拒绝歧义名称与重复覆盖。 */
  register<TInput, TOutput>(definition: AgentDefinition<TInput, TOutput>): this {
    const type = definition?.type;
    if (typeof type !== 'string' || type.length > 64 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(type)) {
      throw new Error('INVALID_AGENT_TYPE');
    }
    if (this.agents.has(type)) throw new Error('DUPLICATE_AGENT_TYPE');
    if (typeof definition.description !== 'string' || typeof definition.parseInput !== 'function' || typeof definition.run !== 'function') {
      throw new Error('INVALID_AGENT_DEFINITION');
    }
    this.agents.set(type, {
      description: definition.description,
      async execute(value, context) {
        const input = definition.parseInput(value);
        context.assertActive();
        await definition.run({ ...context, input });
      },
    });
    return this;
  }

  /** 返回能力目录副本，调用方不能修改注册表。 */
  list(): { type: string; description: string }[] {
    return [...this.agents].map(([type, definition]) => ({ type, description: definition.description }));
  }

  /** 校验输入后执行能力，并在执行与每次输出前后检查取消和宿主授权。 */
  async execute(type: string, input: unknown, context: ExecutionHost): Promise<void> {
    const definition = this.agents.get(type);
    if (!definition) throw new Error('UNKNOWN_AGENT_TYPE');
    let open = true;
    const inFlightEmits = new Set<Promise<void>>();
    const assertActive = () => {
      context.signal.throwIfAborted();
      if (!open) throw new Error('AGENT_RUN_FINISHED');
      context.assertActive();
      context.signal.throwIfAborted();
    };
    const guarded: ExecutionHost = {
      runId: context.runId,
      signal: context.signal,
      assertActive,
      reportActivity(activity) {
        // 状态展示是旁路能力；宿主异常或执行结束后不影响结果提交。
        if (!open || context.signal.aborted) return;
        try { assertActive(); context.reportActivity?.(activity); } catch { /* 忽略状态上报错误。 */ }
      },
      async emit(result) {
        assertActive();
        const commit = Promise.resolve().then(() => {
          assertActive();
          return context.emit(result);
        });
        inFlightEmits.add(commit);
        try {
          await commit;
          assertActive();
        } finally {
          inFlightEmits.delete(commit);
        }
      },
    };
    try {
      assertActive();
      await abortable(() => {
        assertActive();
        return definition.execute(input, guarded);
      }, context.signal);
      assertActive();
    } finally {
      open = false;
      // 已开始的写入由宿主负责取消；执行返回前必须等其结束，避免与收尾持久化竞争。
      await Promise.allSettled(inFlightEmits);
    }
  }
}
