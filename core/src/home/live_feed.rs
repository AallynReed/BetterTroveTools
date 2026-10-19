//! backend/live_feed.py: one Server-Sent Events connection to the TroveAPI, opened at
//! launch and fanned out in-process to the page and the event notifier.

use std::io::BufRead;
use std::sync::{Arc, Once, OnceLock};
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::{http, Args, Resp, KIWI_API_BASE};

const RECONNECT: Duration = Duration::from_secs(5);
/// The server pings about every 20s, so a longer silence means a dead socket.
const READ_TIMEOUT: Duration = Duration::from_secs(45);

type Subscriber = Arc<dyn Fn(&str, &Value) + Send + Sync>;

#[derive(Default)]
struct State {
    connected: bool,
    /// Event type → its most recent payload.
    last: Map<String, Value>,
}

#[derive(Default)]
pub struct LiveFeed {
    subscribers: Mutex<Vec<Subscriber>>,
    state: Mutex<State>,
}

impl LiveFeed {
    /// Registers `callback(event_type, data)`, called on the stream thread.
    pub fn subscribe(&self, callback: impl Fn(&str, &Value) + Send + Sync + 'static) {
        self.subscribers.lock().push(Arc::new(callback));
    }

    pub fn is_connected(&self) -> bool {
        self.state.lock().connected
    }

    /// Last payload seen per event type.
    pub fn snapshot(&self) -> Map<String, Value> {
        self.state.lock().last.clone()
    }

    fn publish(&self, event_type: &str, data: &Value) {
        let subscribers = self.subscribers.lock().clone();
        for callback in subscribers {
            // One failing subscriber must not starve the others.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(event_type, data)));
        }
    }

    pub fn set_connected(&self, connected: bool) {
        {
            let mut state = self.state.lock();
            if state.connected == connected {
                return;
            }
            state.connected = connected;
        }
        self.publish("_status", &json!({ "connected": connected }));
    }

    pub fn dispatch(&self, event_type: &str, data: &str) {
        let Ok(payload) = serde_json::from_str::<Value>(data) else { return };
        let Some(data) = payload.get("data").filter(|d| d.is_object()) else { return };
        self.state.lock().last.insert(event_type.to_string(), data.clone());
        self.publish(event_type, data);
    }

    /// Parses `event:` / `data:` frames until the stream ends.
    pub fn consume(&self, mut reader: impl BufRead) -> std::io::Result<()> {
        let mut event_type = String::new();
        let mut data_lines: Vec<String> = Vec::new();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            if reader.read_until(b'\n', &mut buf)? == 0 {
                return Ok(());
            }
            if buf.last() == Some(&b'\n') {
                buf.pop();
            }
            let text = String::from_utf8_lossy(&buf);
            let text = text.strip_suffix('\r').unwrap_or(&text);
            // A lone CR ends a line too, as Python's splitlines() has it.
            for line in text.split('\r') {
                if line.is_empty() {
                    if !event_type.is_empty() && !data_lines.is_empty() {
                        self.dispatch(&event_type, &data_lines.join("\n"));
                    }
                    event_type.clear();
                    data_lines.clear();
                } else if line.starts_with(':') {
                    continue;
                } else if let Some(rest) = line.strip_prefix("event:") {
                    event_type = rest.trim().to_string();
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                }
            }
        }
    }

    pub(super) fn connect_once(&self) -> Result<()> {
        let req = stream_agent()
            .get(&format!("{}/events/stream", KIWI_API_BASE))
            .set("Accept", "text/event-stream")
            .set("User-Agent", "BetterTroveTools");
        let response = super::raise_for_status(http::send(req)?)?;
        self.set_connected(true);
        self.consume(std::io::BufReader::new(response.into_reader()))?;
        Ok(())
    }

    fn run(&self) {
        loop {
            let _ = self.connect_once();
            self.set_connected(false);
            std::thread::sleep(RECONNECT);
        }
    }
}

/// The shared agent has no per-read timeout, which a long-lived stream needs.
fn stream_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(READ_TIMEOUT).build())
}

pub fn feed() -> &'static LiveFeed {
    static FEED: OnceLock<LiveFeed> = OnceLock::new();
    FEED.get_or_init(|| {
        let feed = LiveFeed::default();
        feed.subscribe(|event_type, data| {
            if let Some(c) = crate::ctx::try_ctx() {
                c.js("receive_live_event", vec![json!(event_type), data.clone()]);
            }
        });
        feed.subscribe(|event_type, data| super::event_notifications::notifier().on_event(event_type, data));
        feed
    })
}

/// `feed.start()`: opens the stream on a background thread, once.
pub fn start() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new().name("live-feed".into()).spawn(|| feed().run());
    });
}

pub fn get_live_feed_status(_: &Args) -> Result<Value> {
    let data = json!({ "connected": feed().is_connected(), "events": feed().snapshot() });
    Ok(Resp::ok(data).spread().into())
}
