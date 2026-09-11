/** Time windows, and what happens when the queue drains. */

import { Field, Row, Segmented, Switch } from "../ui";
import { ScheduleEditor } from "../ScheduleEditor";
import { parseSpeed, formatSpeed } from "../../lib/format";
import type { OnQueueComplete, Settings } from "../../lib/types";
import {
  DraftInput,
  Group,
  Setting,
  patch,
  speedCommit,
  speedToText,
} from "./kit";

export function SchedulerTab({ settings }: { settings: Settings }) {
  return (
    <>
      <Group
        id="scheduler.options"
        description="Holds scheduled downloads back until one of the windows below is open."
      >
        <Setting id="scheduler.options.enabled">
          <Row
            label="Use the scheduler"
            hint="Off by default. While off, nothing here gates anything."
          >
            <Switch
              checked={settings.schedule.enabled}
              label="Use the scheduler"
              onChange={(v) =>
                void patch({ schedule: { ...settings.schedule, enabled: v } })
              }
            />
          </Row>
        </Setting>

        <Setting id="scheduler.options.newDownloads">
          <Row
            label="Schedule new downloads by default"
            hint="New downloads arrive waiting for a window instead of starting straight away."
          >
            <Switch
              checked={settings.scheduleNewDownloads}
              label="Schedule new downloads by default"
              onChange={(v) => void patch({ scheduleNewDownloads: v })}
            />
          </Row>
        </Setting>

        <Setting id="scheduler.options.pauseOutside">
          <Row
            label="Pause when a window closes"
            hint="Off lets a transfer that started inside a window run past the end of it."
          >
            <Switch
              checked={settings.pauseOutsideWindow}
              label="Pause when a window closes"
              onChange={(v) => void patch({ pauseOutsideWindow: v })}
            />
          </Row>
        </Setting>

        <Setting id="scheduler.options.speedLimit">
          <div className="py-2.5">
            <Field label="Speed limit inside windows">
              <DraftInput
                value={speedToText(settings.scheduledSpeedLimitBps)}
                aria-label="Speed limit inside scheduler windows"
                placeholder="0 = use the global limit"
                style={{ width: 190 }}
                onCommit={speedCommit("scheduledSpeedLimitBps")}
                hint={(draft) => {
                  const parsed = parseSpeed(draft);
                  if (parsed === null)
                    return "Not a speed — try 2 MB, 500k, or 0 to use the global limit.";
                  if (parsed === 0) return "Windows use the global limit.";
                  return `Inside a window, capped at ${formatSpeed(parsed)}.`;
                }}
              />
            </Field>
          </div>
        </Setting>

        <Setting id="scheduler.options.onComplete">
          <div className="py-2.5">
            <Field
              label="When the queue finishes"
              hint="Only fires when the last download completes; there is a countdown you can cancel first."
            >
              <Segmented<OnQueueComplete>
                value={settings.onQueueComplete}
                onChange={(v) => void patch({ onQueueComplete: v })}
                options={[
                  { value: "nothing", label: "Nothing" },
                  { value: "sleep", label: "Sleep" },
                  { value: "hibernate", label: "Hibernate" },
                  { value: "shutdown", label: "Shut down" },
                  { value: "exit", label: "Exit" },
                ]}
              />
            </Field>
          </div>
        </Setting>
      </Group>

      <Setting id="scheduler.windows.editor">
        <ScheduleEditor
          schedule={settings.schedule}
          onChange={(schedule) => void patch({ schedule })}
        />
      </Setting>
    </>
  );
}
