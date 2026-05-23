//! Lamport logical clock.
//!
//! Backed by `sync_state.logical_clock` (RFC-002 §7.2). On send, the
//! device bumps `local = max(local, max_seen_remote) + 1` and stamps the
//! outgoing event. On apply, the device merges with whatever clock the
//! remote event carried.
//!
//! The clock has a single property we care about: a *causal* event always
//! has a strictly greater clock than the event that caused it. Equal
//! clocks (two devices acting in parallel) are broken by `(clock,
//! device_id)` lex order, which is enforced by the file naming convention
//! in [`crate::repo::RepoPaths::event_filename`].

use std::sync::atomic::{AtomicU64, Ordering};

/// In-memory Lamport clock. Persistence to `sync_state` is the engine's
/// responsibility — this type just holds the current value and exposes
/// the two operations the protocol calls for.
#[derive(Debug, Default)]
pub struct LogicalClock {
    value: AtomicU64,
}

impl LogicalClock {
    pub fn new(initial: u64) -> Self {
        Self {
            value: AtomicU64::new(initial),
        }
    }

    pub fn get(&self) -> u64 {
        self.value.load(Ordering::SeqCst)
    }

    /// Tick locally before emitting an outgoing event. Returns the new
    /// clock value, which the caller stamps onto the event.
    pub fn tick(&self) -> u64 {
        // SeqCst keeps the contract simple: a thread that observed any
        // earlier tick will see this one too.
        let prev = self.value.fetch_add(1, Ordering::SeqCst);
        prev + 1
    }

    /// Observe a remote event's clock. Bumps the local clock to
    /// `max(local, remote)` so subsequent ticks dominate it.
    pub fn observe(&self, remote: u64) {
        let mut current = self.value.load(Ordering::SeqCst);
        loop {
            if remote <= current {
                return;
            }
            match self.value.compare_exchange(
                current,
                remote,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_is_monotonic() {
        let c = LogicalClock::default();
        assert_eq!(c.tick(), 1);
        assert_eq!(c.tick(), 2);
        assert_eq!(c.tick(), 3);
        assert_eq!(c.get(), 3);
    }

    #[test]
    fn observe_advances_when_remote_is_higher() {
        let c = LogicalClock::new(5);
        c.observe(10);
        assert_eq!(c.get(), 10);
        assert_eq!(c.tick(), 11);
    }

    #[test]
    fn observe_is_a_noop_when_remote_is_not_higher() {
        let c = LogicalClock::new(20);
        c.observe(15);
        c.observe(20);
        assert_eq!(c.get(), 20);
    }

    #[test]
    fn parallel_ticks_are_unique() {
        // 8 threads each tick 1000 times → 8000 distinct values.
        let c = std::sync::Arc::new(LogicalClock::default());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let c = c.clone();
            handles.push(std::thread::spawn(move || {
                let mut seen = Vec::with_capacity(1000);
                for _ in 0..1000 {
                    seen.push(c.tick());
                }
                seen
            }));
        }
        let mut all = Vec::new();
        for h in handles {
            all.extend(h.join().unwrap());
        }
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 8000);
        assert_eq!(all.last().copied(), Some(8000));
    }
}
