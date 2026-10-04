import { createLocalHttpServer } from "./http.mjs";

if (process.env.FRONTEND_ATLAS_LOCAL_MODE !== "1") {
  process.stderr.write("The SIWC service can only start through the local app runner.\n");
  process.exit(1);
}

const server = createLocalHttpServer();
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    process.stderr.write("Local SIWC port 4317 is already in use; no alternate port was selected.\n");
  } else {
    process.stderr.write("The local SIWC service could not start.\n");
  }
  process.exitCode = 1;
});
server.listen(4317, "127.0.0.1", () => {
  process.stdout.write("Local SIWC service listening on 127.0.0.1:4317.\n");
});

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4_000).unref();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
