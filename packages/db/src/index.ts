export type DbConnectionStatus = "disconnected" | "connected";

export function getDefaultDbStatus(): DbConnectionStatus {
  return "disconnected";
}
