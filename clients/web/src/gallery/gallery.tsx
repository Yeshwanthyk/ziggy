import { App } from "@/App";
import { AutomationRow } from "@/components/automation-row";
import { BotAvatar } from "@/components/bot-avatar";
import { MessageMarkdown } from "@/components/message-markdown";
import { SidebarSection } from "@/components/sidebar-section";
import { ToolActivity } from "@/components/tool-activity";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Plus, Star } from "lucide-react";
import type { ReactNode } from "react";
import { fixtureConnector, fixtureScenarios, isFixtureScenario } from "./fixture-gateway";
import "./gallery.css";

const noop = (): void => undefined;

const viewports = [
  { name: "Phone", width: 390, height: 844 },
  { name: "Desktop", width: 1280, height: 800 },
] as const;

/** `/gallery/screen?scenario=…` renders the real app on sample data; `/gallery` lists everything. */
export const galleryRoute = (): ReactNode => {
  if (location.pathname.startsWith("/gallery/screen")) {
    const requested = new URLSearchParams(location.search).get("scenario");
    const scenario = isFixtureScenario(requested) ? requested : "conversation";
    return (
      <App
        connection={{ connector: fixtureConnector(scenario), url: "ws://gallery.invalid/ws" }}
        key={scenario}
      />
    );
  }
  return <Gallery />;
};

function Section({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="gallery-section">
      <h2>{title}</h2>
      <div className="gallery-row">{children}</div>
    </section>
  );
}

function Gallery() {
  return (
    <main className="gallery">
      <header className="gallery-header">
        <h1>Ziggy components</h1>
        <p>Dev-only. Screens use sample data and follow the system light or dark setting.</p>
      </header>

      {fixtureScenarios.map((scenario) => (
        <section className="gallery-section" key={scenario}>
          <h2>
            Chat screen · {scenario}{" "}
            <a href={`/gallery/screen?scenario=${scenario}`} rel="noreferrer" target="_blank">
              open
            </a>
          </h2>
          <div className="gallery-row gallery-screens">
            {viewports.map((viewport) => (
              <figure key={viewport.name}>
                <iframe
                  height={viewport.height}
                  src={`/gallery/screen?scenario=${scenario}`}
                  title={`${scenario} at ${viewport.name} width`}
                  width={viewport.width}
                />
                <figcaption>
                  {viewport.name} · {viewport.width}×{viewport.height}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}

      <Section title="Buttons">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
        <Button size="xs">Extra small</Button>
        <Button aria-label="Add" size="icon" variant="outline">
          <Plus />
        </Button>
        <Button aria-label="Pin" size="icon-sm" variant="ghost">
          <Star />
        </Button>
        <Button aria-label="Send" className="send-button" size="icon">
          <ArrowUp />
        </Button>
      </Section>

      <Section title="Bot avatars">
        {[16, 24, 32, 56].map((size) => (
          <BotAvatar key={size} name="Squarey" size={size} />
        ))}
        <BotAvatar active name="Squarey" size={56} />
        <BotAvatar name="researcher" size={56} />
        <BotAvatar name="arty" size={56} />
      </Section>

      <Section title="Messages">
        <div className="gallery-transcript transcript">
          <article className="message user">
            <div className="message-body">What creative tools are installed?</div>
          </article>
          <article className="message assistant">
            <div className="message-author">Squarey</div>
            <div className="message-body">
              <MessageMarkdown>
                {
                  "**Heading** with `code` and a [link](https://example.com).\n\n- One\n- Two\n\n```ts\nconst x = 1;\n```"
                }
              </MessageMarkdown>
            </div>
          </article>
          <ToolActivity count={2}>
            <div className="tool-line">
              <span className="tool-dot" />
              <span>bash</span>
              <span>finished</span>
            </div>
            <div className="tool-line">
              <span className="tool-dot is-error" />
              <span>read</span>
              <span>failed</span>
            </div>
          </ToolActivity>
          <div className="tool-line live">
            <span className="tool-dot" />
            <span>web_search</span>
            <span>working</span>
          </div>
        </div>
      </Section>

      <Section title="Composer">
        <div className="gallery-composer composer-panel">
          <form className="composer" onSubmit={(event) => event.preventDefault()}>
            <Textarea aria-label="Message" placeholder="Message Squarey" rows={1} />
            <Button aria-label="Send" className="send-button" size="icon" type="submit">
              <ArrowUp />
            </Button>
          </form>
        </div>
      </Section>

      <Section title="Sidebar">
        <aside className="gallery-sidebar sidebar" data-open="true">
          <SidebarSection
            action={{ icon: <Plus />, label: "New group", onClick: noop }}
            title="Groups"
          >
            {[]}
          </SidebarSection>
          <SidebarSection empty="Nothing pinned yet." title="Pinned">
            {[]}
          </SidebarSection>
          <SidebarSection title="Automations">
            <AutomationRow
              automation={{ id: "morning-weather", lifecycle: "active", schedule: "0 8 * * *" }}
              busy={false}
              onInspect={noop}
              onPause={noop}
              onResume={noop}
              onRun={noop}
            />
            <AutomationRow
              automation={{ id: "weekly-review", lifecycle: "paused" }}
              busy={false}
              onInspect={noop}
              onPause={noop}
              onResume={noop}
              onRun={noop}
            />
            <AutomationRow
              automation={{ id: "broken", lifecycle: "conflict", message: "Invalid schedule" }}
              busy={false}
              onInspect={noop}
              onPause={noop}
              onResume={noop}
              onRun={noop}
            />
            <AutomationRow
              automation={{ id: "running", lifecycle: "active", schedule: "0 8 * * *" }}
              busy
              onInspect={noop}
              onPause={noop}
              onResume={noop}
              onRun={noop}
              runState="running"
            />
          </SidebarSection>
        </aside>
      </Section>
    </main>
  );
}
