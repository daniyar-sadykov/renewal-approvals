// Ожидание состояния опросом с таймаутом, вместо сна «на удачу».
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 15000, intervalMs = 50, what = 'условие' }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Не дождались: ${what} за ${timeoutMs} мс. Последнее значение: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await probe();
  }
  return last;
}
