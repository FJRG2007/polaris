use std::sync::Arc;

use futures::StreamExt;
use futures::channel::oneshot;
use ptermui_core::r#async::executor::Background;

use super::*;

/// A test error type.
#[derive(Debug, thiserror::Error)]
#[error("test error")]
struct TestError;

impl IsTransientError for TestError {
    fn is_transient(&self) -> bool {
        false
    }
}

/// A test task that has an identifier and can optionally block on a signal
/// before completing.
struct TestTask {
    id: u32,
    /// If set, the task waits for this signal before returning.
    gate: Option<oneshot::Receiver<()>>,
    /// If set, the task signals here as soon as the processor starts running it.
    started: Option<oneshot::Sender<()>>,
}

impl SyncQueueTaskTrait for TestTask {
    type Error = TestError;
    type Result = u32;
    type Fut = std::pin::Pin<Box<dyn Future<Output = Result<u32, TestError>> + Send>>;

    fn run(&mut self) -> Self::Fut {
        let id = self.id;
        let gate = self.gate.take();
        if let Some(started) = self.started.take() {
            let _ = started.send(());
        }
        Box::pin(async move {
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            Ok(id)
        })
    }
}

fn create_queue() -> (SyncQueue<TestTask>, Arc<Background>) {
    let executor = Arc::new(Background::default());
    let queue = SyncQueue::new(&executor);
    (queue, executor)
}

fn ungated_task(id: u32) -> TestTask {
    TestTask {
        id,
        gate: None,
        started: None,
    }
}

/// A task that blocks until the returned gate sender fires (or is dropped),
/// plus a receiver that resolves once the processor has started running it.
fn gated_task(id: u32) -> (TestTask, oneshot::Sender<()>, oneshot::Receiver<()>) {
    let (gate_tx, gate_rx) = oneshot::channel();
    let (started_tx, started_rx) = oneshot::channel();
    let task = TestTask {
        id,
        gate: Some(gate_rx),
        started: Some(started_tx),
    };
    (task, gate_tx, started_rx)
}

/// Blocks until the processor has started the task behind `started`, i.e. it
/// has left the queue and is the active, abortable task.
fn wait_until_started(started: oneshot::Receiver<()>) {
    futures::executor::block_on(started).expect("task should start running");
}

#[test]
fn has_queued_task_finds_matching_task() {
    let (queue, _executor) = create_queue();

    // Enqueue a blocking task to hold the processor so subsequent tasks stay queued.
    let (blocker, gate_tx, started) = gated_task(0);
    drop(futures::executor::block_on(
        queue.enqueue_with_result(blocker, None, "blocker"),
    ));

    // Enqueue the tasks we want to check.
    drop(futures::executor::block_on(queue.enqueue_with_result(
        ungated_task(1),
        None,
        "task-1",
    )));
    drop(futures::executor::block_on(queue.enqueue_with_result(
        ungated_task(2),
        None,
        "task-2",
    )));

    // Wait until the processor is running the gated task.
    wait_until_started(started);

    // Tasks 1 and 2 should be queued (not executing).
    assert!(queue.has_queued_task(|task| task.id == 1));
    assert!(queue.has_queued_task(|task| task.id == 2));
    assert!(!queue.has_queued_task(|task| task.id == 99));

    // Unblock so the test cleans up.
    let _ = gate_tx.send(());
}

#[test]
fn has_queued_task_does_not_match_executing_task() {
    let (queue, _executor) = create_queue();

    // Enqueue a task that will block — it will be picked up by the processor.
    let (blocker, gate_tx, started) = gated_task(1);
    drop(futures::executor::block_on(queue.enqueue_with_result(
        blocker,
        None,
        "blocking-task",
    )));

    // Wait until the processor is running the gated task.
    wait_until_started(started);

    // The task should be executing (removed from the map), not queued.
    assert!(!queue.has_queued_task(|task| task.id == 1));

    let _ = gate_tx.send(());
}

#[test]
fn cancel_all_cancels_running_and_queued_tasks() {
    let (queue, _executor) = create_queue();

    // Enqueue a task that blocks — this will be the "running" task.
    // The gate sender is held until the end of the test, so the task can only
    // finish by being aborted.
    let (blocker, _gate_tx, started) = gated_task(1);
    let running_rx =
        futures::executor::block_on(queue.enqueue_with_result(blocker, None, "running-task"));

    // Enqueue a second task that will sit in the queue waiting.
    let queued_rx = futures::executor::block_on(queue.enqueue_with_result(
        ungated_task(2),
        None,
        "queued-task",
    ));

    // Wait until the processor is running the gated task.
    wait_until_started(started);

    // Cancel everything.
    queue.cancel_all();

    // Both receivers should resolve to Err(Canceled) since their senders
    // were dropped without sending a result.
    assert!(
        futures::executor::block_on(running_rx).is_err(),
        "running task receiver should be cancelled"
    );
    assert!(
        futures::executor::block_on(queued_rx).is_err(),
        "queued task receiver should be cancelled"
    );
}

fn create_streaming_queue() -> (SyncQueue<TestTask>, Arc<Background>) {
    let executor = Arc::new(Background::default());
    let queue = SyncQueue::new_streaming(&executor);
    (queue, executor)
}

#[test]
fn streaming_subscribe_receives_all_results() {
    let (queue, _executor) = create_streaming_queue();
    let mut rx1 = queue.subscribe();
    let mut rx2 = queue.subscribe();

    queue.enqueue(ungated_task(1), None, "task-1");
    queue.enqueue(ungated_task(2), None, "task-2");

    // Both receivers should get both results.
    let r1_a = futures::executor::block_on(rx1.next()).unwrap();
    let r1_b = futures::executor::block_on(rx1.next()).unwrap();
    let r2_a = futures::executor::block_on(rx2.next()).unwrap();
    let r2_b = futures::executor::block_on(rx2.next()).unwrap();

    assert_eq!(*r1_a.unwrap(), 1);
    assert_eq!(*r1_b.unwrap(), 2);
    assert_eq!(*r2_a.unwrap(), 1);
    assert_eq!(*r2_b.unwrap(), 2);
}

#[test]
#[should_panic(expected = "subscribe() called on a per-task queue")]
fn subscribe_panics_on_per_task_queue() {
    let (queue, _executor) = create_queue();
    let _ = queue.subscribe();
}

#[test]
#[should_panic(expected = "enqueue() called on a per-task queue")]
fn enqueue_panics_on_per_task_queue() {
    let (queue, _executor) = create_queue();
    queue.enqueue(ungated_task(1), None, "task-1");
}

#[test]
#[should_panic(expected = "enqueue_with_result() called on a streaming queue")]
fn enqueue_with_result_panics_on_streaming_queue() {
    let (queue, _executor) = create_streaming_queue();
    // Use drop() instead of `let _ =` to satisfy clippy::let_underscore_future.
    // The test panics inside enqueue_with_result before this value is used.
    drop(futures::executor::block_on(queue.enqueue_with_result(
        ungated_task(1),
        None,
        "task-1",
    )));
}

#[test]
fn streaming_cancel_all_clears_queued_tasks() {
    let (queue, _executor) = create_streaming_queue();
    let _rx = queue.subscribe();

    // Enqueue a blocking task so subsequent tasks stay queued.
    let (blocker, _gate_tx, started) = gated_task(0);
    queue.enqueue(blocker, None, "blocker");
    queue.enqueue(ungated_task(1), None, "task-1");

    // Wait until the processor is running the gated task.
    wait_until_started(started);

    assert!(queue.has_queued_task(|task| task.id == 1));
    queue.cancel_all();
    assert!(!queue.has_queued_task(|task| task.id == 1));
}
