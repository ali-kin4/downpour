/** How Downpour tells you something happened. */

import { Row, Switch } from "../ui";
import type { Settings } from "../../lib/types";
import { Group, Setting, patch } from "./kit";

export function NotificationsTab({ settings }: { settings: Settings }) {
  return (
    <>
      <Group
        id="notifications.toasts"
        description="Windows toasts, raised by Downpour when a download reaches a final state."
      >
        <Setting id="notifications.toasts.complete">
          <Row label="Notify when a download completes">
            <Switch
              checked={settings.notifyOnComplete}
              label="Notify when a download completes"
              onChange={(v) => void patch({ notifyOnComplete: v })}
            />
          </Row>
        </Setting>

        <Setting id="notifications.toasts.error">
          <Row
            label="Notify when a download fails"
            hint="Includes the reason it gave up, so a failure is not silent."
          >
            <Switch
              checked={settings.notifyOnError}
              label="Notify when a download fails"
              onChange={(v) => void patch({ notifyOnError: v })}
            />
          </Row>
        </Setting>

        <Setting id="notifications.toasts.sound">
          <Row
            label="Play a sound on completion"
            hint="Off by default. Unsolicited noise from a background app is rude."
          >
            <Switch
              checked={settings.soundOnComplete}
              label="Play a sound on completion"
              onChange={(v) => void patch({ soundOnComplete: v })}
            />
          </Row>
        </Setting>
      </Group>

      <Group id="notifications.panel">
        <Setting id="notifications.panel.progressWindow">
          <Row
            label="Show the floating progress panel"
            hint="A small window that sits above everything else while a transfer runs, showing what is moving and how fast. Closing it does not stop the download."
          >
            <Switch
              checked={settings.progressWindow}
              label="Show the floating progress panel"
              onChange={(v) => void patch({ progressWindow: v })}
            />
          </Row>
        </Setting>
      </Group>
    </>
  );
}
