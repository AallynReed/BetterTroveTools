//! The home dashboard: backend/home.py, backend/live_feed.py,
//! backend/event_notifications.py, utils/trove/server_time.py and utils/image_proxy.py.

mod delve;
mod event_notifications;
mod feeds;
mod image_proxy;
mod live_feed;
mod py;
mod rotations;
mod server_time;

#[cfg(test)]
mod tests;

use crate::http::raise_for_status;
use crate::routes::Route;
use crate::Cmd;

pub fn commands() -> Vec<Cmd> {
    let mut all = feeds::commands();
    all.extend(rotations::commands());
    all.extend(delve::commands());
    all.push(Cmd::std("get_live_feed_status", live_feed::get_live_feed_status));
    all.push(Cmd::std("apply_event_notifications", event_notifications::apply_event_notifications));
    all
}

pub fn routes() -> Vec<Route> {
    vec![Route::get("/proxy/bilibili_image", image_proxy::proxy_bilibili_image)]
}

/// backend.live_feed.feed.start(): the shared TroveAPI SSE connection. Returns at once.
pub fn start_live_feed() {
    live_feed::start();
}
