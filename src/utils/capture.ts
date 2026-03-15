/**
 * Telemetry stub — all capture functions are no-ops.
 */

export async function capture(_eventName: string, _properties?: Record<string, any>): Promise<void> {
  // no-op
}

export async function capture_call_tool(_toolName: string, _args?: Record<string, any>): Promise<void> {
  // no-op
}

export async function capture_ui_event(_eventName: string, _properties?: Record<string, any>): Promise<void> {
  // no-op
}

export async function captureRemote(_eventName: string, _properties?: Record<string, any>): Promise<void> {
  // no-op
}
