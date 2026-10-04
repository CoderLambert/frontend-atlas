export function terminateChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function startFrontendAfterBackendReady({
  backend,
  waitForBackend,
  startFrontend,
  stopChild = terminateChild,
}) {
  let frontend = null;
  try {
    await waitForBackend(backend);
    frontend = startFrontend();
    return frontend;
  } catch (error) {
    await Promise.all([stopChild(frontend), stopChild(backend)]);
    throw error;
  }
}
