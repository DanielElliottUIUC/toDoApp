// Connection details for the throwaway test database. Nothing here is a real
// credential: the server exists only for the length of a test run.
export const PORT = 54331;
export const ADMIN_PASSWORD = "test-admin";
export const ROLE_PASSWORD = "test-role";
export const TEMPLATE_DB = "lifeops_template";

export const adminUrl = (db: string) => `postgres://postgres:${ADMIN_PASSWORD}@localhost:${PORT}/${db}`;
export const workerUrl = (db: string) => `postgres://app_worker:${ROLE_PASSWORD}@localhost:${PORT}/${db}`;
export const dispatcherUrl = (db: string) => `postgres://app_dispatcher:${ROLE_PASSWORD}@localhost:${PORT}/${db}`;
