import { auth } from "../auth.ts";
import { readMockAuthUserId } from "./mock-auth.ts";

export interface SessionReader {
  getUserId(request: Request): Promise<string | null>;
}

export const authSessionReader: SessionReader = {
  async getUserId(request) {
    const mockUserId = readMockAuthUserId(request);
    if (mockUserId) return mockUserId;
    const session = auth ? await auth.api.getSession({ headers: request.headers }) : null;
    return session?.user.id ?? null;
  },
};
