/** The person a request is for, as the auth guard found them. */
export interface AuthUser {
  id: string;
  isGuest: boolean;
}

declare global {
  // biome-ignore lint/style/noNamespace: Express's global Request can only be extended through its namespace.
  namespace Express {
    interface Request {
      /** Set by JwtAuthGuard on every route that is not @Public(). */
      user?: AuthUser;
    }
  }
}
