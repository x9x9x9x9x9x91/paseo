import type { RefObject } from "react";
import type { KeyboardInputEvent } from "./overlays";
export interface OverlayRegistration {
  active: boolean;
  layer: number;
  /**
   * Keys the overlay handles. Native forwards only these. On web, declaring "Tab" hands Tab to
   * `onKeyDown` instead of the focus trap.
   */
  keys: readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
  restoreFocusRef?: RefObject<unknown>;
  manageFocus?: boolean;
  /**
   * A control that rides on the user's own text selection still answers keys first, so
   * Escape dismisses it instead of interrupting the agent, but it does not count as an open
   * overlay: find shortcuts keep working while it shows.
   */
  passive?: boolean;
}
