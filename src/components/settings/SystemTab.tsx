/** How Downpour behaves as a desktop application. */

import { Row, Switch } from "../ui";
import type { Settings } from "../../lib/types";
import { Group, Setting, patch } from "./kit";

export function SystemTab({ settings }: { settings: Settings }) {
  return (
    <Group
      id="system.windows"
      description="Starting, hiding and quitting — the parts of Downpour that Windows itself is in charge of."
    >
      <Setting id="system.windows.launchAtLogin">
        <Row
          label="Launch at login"
          hint="Adds Downpour to Windows startup. The registry entry is reconciled with this setting on every launch."
        >
          <Switch
            checked={settings.launchAtLogin}
            label="Launch at login"
            onChange={(v) => void patch({ launchAtLogin: v })}
          />
        </Row>
      </Setting>

      <Setting id="system.windows.startMinimized">
        <Row
          label="Start minimised"
          hint="Opens straight to the tray, which only makes sense alongside launch at login."
        >
          <Switch
            checked={settings.startMinimized}
            label="Start minimised"
            onChange={(v) => void patch({ startMinimized: v })}
          />
        </Row>
      </Setting>

      <Setting id="system.windows.closeToTray">
        <Row
          label="Close to the tray"
          hint="The window close button hides Downpour instead of quitting, so transfers keep running. Off makes closing quit."
        >
          <Switch
            checked={settings.closeToTray}
            label="Close to the tray"
            onChange={(v) => void patch({ closeToTray: v })}
          />
        </Row>
      </Setting>
    </Group>
  );
}
