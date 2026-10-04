//! The per-origin connection budget.
//!
//! [`MAX_CONNECTIONS`](crate::transfer::MAX_CONNECTIONS) is a promise about a
//! *server*, not about one download: no more than that many requests in flight
//! to one origin at once, however many files are coming from it. Enforced per
//! download, three files from one host at eight connections each quietly made
//! it twenty-four -- exactly the behaviour that earns a 429 or an IP ban.
//!
//! Three limits are easy to confuse and are deliberately separate:
//!
//! - **this budget** bounds requests actually in flight to an origin;
//! - the client's idle pool (`pool_max_idle_per_host`) only bounds how many
//!   *idle* sockets are kept for reuse, and limits nothing that is running;
//! - the engine's concurrent-download setting bounds how many *files* run,
//!   whatever their origin.
//!
//! A slot is held for one request and released the moment it ends, never
//! across a retry's backoff, so a download waiting out a `429` does not hoard
//! capacity another could use.
//!
//! # Fairness
//!
//! A released slot goes to the waiting download that holds the *fewest*
//! slots, first come first served between equals -- not simply to whoever
//! queued first. A plain FIFO cannot direct a slot: one handed back so another
//! download can start lands with the next queued request, which is as likely
//! as not the giver's own, and it gives the slot back again on its next chunk.
//!
//! A download yields a slot only when it holds more than an even share *and*
//! another download is waiting with less than one. The share is reckoned over
//! downloads that want connections -- holding or waiting for some. Counting a
//! download that is only sleeping out a `Retry-After` or hashing its finished
//! file shrinks everyone's share below what they hold, and the others then
//! yield and retake slots chunk after chunk in an endless storm of requests.
//! With both conditions, and the slot steered to the download short of its
//! share, every yield closes a real deficit and the yielding stops.
//!
//! An origin is scheme, host and effective port: what a server, a CDN edge or a
//! rate-limiter actually counts. `http://a` and `https://a` are different
//! servers as far as connections go.
//!
//! Not covered: a probe that is redirected reaches the final host inside
//! reqwest, under the slot of the host it started at, so for that one short
//! request the final host can see one connection more than its budget.

use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use tokio::sync::oneshot;

/// The engine-wide pool of connection budgets, one per origin, created on first
/// use and dropped when nothing refers to them.
#[derive(Debug)]
pub struct ConnectionBudget {
    per_origin: usize,
    origins: Mutex<HashMap<String, Weak<Origin>>>,
}

#[derive(Debug)]
struct Origin {
    per_origin: usize,
    next_lease: AtomicU64,
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    available: usize,
    next_ticket: u64,
    waiters: VecDeque<Waiter>,
    /// Every download drawing on this origin, by lease id.
    leases: HashMap<u64, Counts>,
}

#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    held: usize,
    waiting: usize,
}

impl Counts {
    fn wants_connections(self) -> bool {
        self.held + self.waiting > 0
    }
}

#[derive(Debug)]
struct Waiter {
    ticket: u64,
    lease: u64,
    grant: oneshot::Sender<()>,
}

impl ConnectionBudget {
    /// `per_origin` is clamped to the engine's hard ceiling: this can only make
    /// the limit stricter, never lift it.
    pub fn new(per_origin: usize) -> Self {
        Self {
            per_origin: per_origin.clamp(1, crate::transfer::MAX_CONNECTIONS as usize),
            origins: Mutex::new(HashMap::new()),
        }
    }

    /// Registers one download's interest in the origin of `url`.
    pub fn lease(&self, url: &str) -> Lease {
        let key = origin_key(url);
        let origin = {
            let mut map = self.origins.lock();
            match map.get(&key).and_then(Weak::upgrade) {
                Some(origin) => origin,
                None => {
                    let origin = Arc::new(Origin {
                        per_origin: self.per_origin,
                        next_lease: AtomicU64::new(0),
                        state: Mutex::new(State {
                            available: self.per_origin,
                            ..Default::default()
                        }),
                    });
                    // Forget origins nobody holds any more, so a long session
                    // touching many hosts does not accumulate them.
                    map.retain(|_, w| w.strong_count() > 0);
                    map.insert(key, Arc::downgrade(&origin));
                    origin
                }
            }
        };
        let id = origin.next_lease.fetch_add(1, Ordering::Relaxed);
        origin.state.lock().leases.insert(id, Counts::default());
        Lease { origin, id }
    }
}

impl Default for ConnectionBudget {
    fn default() -> Self {
        Self::new(crate::transfer::MAX_CONNECTIONS as usize)
    }
}

impl Origin {
    /// Gives a slot back and, if anyone is waiting, hands it straight on to
    /// the download holding the fewest.
    fn release(&self, lease: u64) {
        let mut st = self.state.lock();
        if let Some(c) = st.leases.get_mut(&lease) {
            c.held = c.held.saturating_sub(1);
        }
        loop {
            let next = st
                .waiters
                .iter()
                .enumerate()
                .min_by_key(|(_, w)| {
                    let held = st.leases.get(&w.lease).map_or(0, |c| c.held);
                    (held, w.ticket)
                })
                .map(|(i, _)| i);
            let Some(i) = next else {
                st.available += 1;
                return;
            };
            let w = st.waiters.remove(i).expect("index from iter");
            if let Some(c) = st.leases.get_mut(&w.lease) {
                c.waiting -= 1;
                c.held += 1;
            }
            if w.grant.send(()).is_ok() {
                return;
            }
            // The waiter gave up as we chose it; undo and pick again.
            if let Some(c) = st.leases.get_mut(&w.lease) {
                c.held -= 1;
            }
        }
    }
}

/// One download's claim on an origin's budget.
#[derive(Debug)]
pub struct Lease {
    origin: Arc<Origin>,
    id: u64,
}

impl Lease {
    /// Waits for a slot. Cancel-safe: dropping the future while it waits, or
    /// in the instant it is granted one, leaves every count as it found it.
    pub async fn acquire(&self) -> Permit {
        let mut queued = {
            let mut st = self.origin.state.lock();
            if st.available > 0 && st.waiters.is_empty() {
                st.available -= 1;
                if let Some(c) = st.leases.get_mut(&self.id) {
                    c.held += 1;
                }
                return self.permit();
            }
            let ticket = st.next_ticket;
            st.next_ticket += 1;
            let (grant, granted) = oneshot::channel();
            st.waiters.push_back(Waiter {
                ticket,
                lease: self.id,
                grant,
            });
            if let Some(c) = st.leases.get_mut(&self.id) {
                c.waiting += 1;
            }
            Queued {
                origin: &self.origin,
                lease: self.id,
                ticket,
                granted: Some(granted),
            }
        };
        let granted = queued.granted.as_mut().expect("set above");
        granted
            .await
            .expect("a waiter is only dropped from the queue by granting it");
        queued.granted = None;
        self.permit()
    }

    fn permit(&self) -> Permit {
        Permit {
            origin: Arc::clone(&self.origin),
            lease: self.id,
        }
    }

    /// Whether this download should hand a slot back: it holds more than an
    /// even share, and another download is waiting with less than one. The
    /// released slot is then steered to that download (see [`Origin::release`]).
    pub fn should_yield(&self) -> bool {
        let st = self.origin.state.lock();
        let Some(me) = st.leases.get(&self.id).copied() else {
            return false;
        };
        let wanting = st
            .leases
            .values()
            .filter(|c| c.wants_connections())
            .count()
            .max(1);
        let share = self.origin.per_origin.div_ceil(wanting).max(1);
        me.held > share
            && st
                .leases
                .iter()
                .any(|(id, c)| *id != self.id && c.waiting > 0 && c.held < share)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.origin.state.lock().leases.remove(&self.id);
    }
}

/// One request's slot. Released on drop, so no path can leak it.
#[derive(Debug)]
pub struct Permit {
    origin: Arc<Origin>,
    lease: u64,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.origin.release(self.lease);
    }
}

/// A request in the queue. Dropped while still queued, it leaves the queue;
/// dropped after a slot was granted but before it was taken, it gives the slot
/// back -- so abandoning a wait can never strand a slot or a count.
struct Queued<'a> {
    origin: &'a Arc<Origin>,
    lease: u64,
    ticket: u64,
    granted: Option<oneshot::Receiver<()>>,
}

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        let Some(mut granted) = self.granted.take() else {
            return;
        };
        {
            let mut st = self.origin.state.lock();
            if let Some(i) = st.waiters.iter().position(|w| w.ticket == self.ticket) {
                st.waiters.remove(i);
                if let Some(c) = st.leases.get_mut(&self.lease) {
                    c.waiting -= 1;
                }
                return;
            }
        }
        // Not queued any more, so `release` granted it under the lock and the
        // grant is already in the channel.
        if granted.try_recv().is_ok() {
            self.origin.release(self.lease);
        }
    }
}

/// `scheme://host:port`, with the port made explicit so `https://a` and
/// `https://a:443` are one origin. An address that does not parse is its own
/// origin, which is safe: it can only make the limit stricter.
fn origin_key(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!(
            "{}://{}:{}",
            u.scheme(),
            u.host_str().unwrap_or(""),
            u.port_or_known_default().unwrap_or(0)
        ),
        Err(_) => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn counts(l: &Lease) -> (usize, usize, usize, usize) {
        let st = l.origin.state.lock();
        let c = st.leases.get(&l.id).copied().unwrap_or_default();
        (st.available, st.waiters.len(), c.held, c.waiting)
    }

    #[test]
    fn an_origin_is_scheme_host_and_effective_port() {
        assert_eq!(
            origin_key("https://Example.com/a"),
            origin_key("https://example.com:443/b")
        );
        assert_ne!(
            origin_key("https://example.com/"),
            origin_key("http://example.com/")
        );
        assert_ne!(
            origin_key("https://example.com/"),
            origin_key("https://example.com:8443/")
        );
        assert_ne!(
            origin_key("https://a.example.com/"),
            origin_key("https://b.example.com/")
        );
    }

    #[test]
    fn the_hard_ceiling_cannot_be_lifted() {
        let b = ConnectionBudget::new(1000);
        assert_eq!(b.per_origin, crate::transfer::MAX_CONNECTIONS as usize);
        assert_eq!(ConnectionBudget::new(0).per_origin, 1);
    }

    #[tokio::test]
    async fn an_abandoned_wait_leaks_nothing() {
        let budget = ConnectionBudget::new(1);
        let a = budget.lease("https://h/");
        let b = budget.lease("https://h/");
        let held = a.acquire().await;
        // B's wait is abandoned, as a pause abandons it.
        let gave_up = tokio::time::timeout(Duration::from_millis(50), b.acquire()).await;
        assert!(gave_up.is_err());
        assert_eq!(counts(&b), (0, 0, 0, 0));
        assert!(!a.should_yield(), "nobody is waiting any more");
        drop(held);
        assert_eq!(counts(&a), (1, 0, 0, 0));
        let _again = tokio::time::timeout(Duration::from_millis(50), b.acquire())
            .await
            .expect("the released slot must be available");
    }

    #[tokio::test]
    async fn a_grant_abandoned_before_it_is_taken_is_given_back() {
        let budget = ConnectionBudget::new(1);
        let a = budget.lease("https://h/");
        let b = budget.lease("https://h/");
        let held = a.acquire().await;
        let mut waiting = Box::pin(b.acquire());
        // Poll once so B is queued, then grant it and drop it unpolled.
        assert!(futures::poll!(waiting.as_mut()).is_pending());
        drop(held);
        drop(waiting);
        assert_eq!(counts(&b), (1, 0, 0, 0), "the slot came back");
    }

    #[tokio::test]
    async fn a_released_slot_goes_to_the_download_holding_fewest() {
        let budget = ConnectionBudget::new(2);
        let a = Arc::new(budget.lease("https://h/"));
        let b = Arc::new(budget.lease("https://h/"));
        let a1 = a.acquire().await;
        let _a2 = a.acquire().await;
        // A queues first, B second; B holds nothing, so B is served first.
        let a_wait = tokio::spawn({
            let a = Arc::clone(&a);
            async move { a.acquire().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let b_wait = tokio::spawn({
            let b = Arc::clone(&b);
            async move { b.acquire().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(a1);
        let _b1 = tokio::time::timeout(Duration::from_millis(200), b_wait)
            .await
            .expect("the slot went to the queue head, not to the download short of it")
            .unwrap();
        assert!(!a_wait.is_finished());
        a_wait.abort();
    }

    #[tokio::test]
    async fn a_download_yields_only_to_another_download_short_of_its_share() {
        let budget = ConnectionBudget::new(4);
        let a = budget.lease("https://h/");
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(a.acquire().await);
        }
        // A's own fifth request waiting is not a reason for A to give one up.
        let own = tokio::time::timeout(Duration::from_millis(20), a.acquire()).await;
        assert!(own.is_err());
        assert!(!a.should_yield());

        // A download that is merely registered -- sleeping out a Retry-After,
        // hashing -- wants nothing and changes nothing.
        let idle = budget.lease("https://h/");
        assert!(!a.should_yield());

        let b = budget.lease("https://h/");
        let b_wait = tokio::spawn(async move {
            let p = b.acquire().await;
            (b, p)
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            a.should_yield(),
            "B waits with nothing; A holds 4 of an even 2"
        );
        held.truncate(2);
        let (_b, _p) = b_wait.await.unwrap();
        assert!(!a.should_yield(), "A is down to its share");
        drop(idle);
    }

    #[tokio::test]
    async fn a_download_that_wants_nothing_does_not_shrink_the_share() {
        // Six slots, two downloads that want them, one merely registered. The
        // even share is three: A with four must give one to B with two. Count
        // the idle one and the share is two, B is "not short", and stays
        // short of a fair split for as long as A runs.
        let budget = ConnectionBudget::new(6);
        let _idle = budget.lease("https://h/");
        let a = budget.lease("https://h/");
        let b = Arc::new(budget.lease("https://h/"));
        let mut held_a = Vec::new();
        for _ in 0..4 {
            held_a.push(a.acquire().await);
        }
        let _b1 = b.acquire().await;
        let _b2 = b.acquire().await;
        let b_wait = tokio::spawn({
            let b = Arc::clone(&b);
            async move { b.acquire().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(a.should_yield(), "B holds 2 of an even 3 and is waiting");
        held_a.pop();
        let _b3 = b_wait.await.unwrap();
        assert!(!a.should_yield());
    }

    #[tokio::test]
    async fn different_origins_do_not_share() {
        let budget = ConnectionBudget::new(1);
        let a = budget.lease("https://a.example/");
        let b = budget.lease("https://b.example/");
        let _pa = a.acquire().await;
        tokio::time::timeout(Duration::from_millis(50), b.acquire())
            .await
            .expect("another origin's full budget must not block this one");
    }
}
