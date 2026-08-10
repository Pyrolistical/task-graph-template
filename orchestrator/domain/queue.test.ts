import { describe, expect, test } from "bun:test";
import { Queue } from "./queue.ts";

describe("Feature: work handed to the tick to run one job at a time", () => {
  test("submitted work sits still until the queue is drained", async () => {
    // Given a queue holding submitted work
    const queue = new Queue();
    const order: string[] = [];
    const submitted = queue.submit(() => {
      order.push("ran");
      return Promise.resolve("done");
    });

    // Given nothing has run
    await Promise.resolve();
    expect(order).toEqual([]);

    // When the queue is drained
    await queue.drain();

    // Then the work ran and the submitter has its answer
    expect(order).toEqual(["ran"]);
    expect(await submitted).toBe("done");
  });

  test("a job still running holds up the ones behind it", async () => {
    // Given a queue draining a job that has not finished
    const queue = new Queue();
    const order: string[] = [];
    let finish!: () => void;
    const running = new Promise<void>((resolve) => (finish = resolve));
    void queue.submit(async () => {
      order.push("first");
      await running;
    });
    void queue.submit(() => {
      order.push("second");
      return Promise.resolve();
    });
    const draining = queue.drain();

    // Given the job behind it has not started
    await Promise.resolve();
    expect(order).toEqual(["first"]);

    // When the running job finishes
    finish();
    await draining;

    // Then the job behind it ran next
    expect(order).toEqual(["first", "second"]);
  });

  test("a job that fails is the only one that fails", async () => {
    // Given a failing job submitted before a healthy one
    const queue = new Queue();
    const failing = queue.submit(() => Promise.reject(new Error("boom")));
    const healthy = queue.submit(() => Promise.resolve("ok"));

    // When the queue is drained
    await queue.drain();

    // Then the failure reached its submitter and the next job still ran
    await expect(failing).rejects.toThrow("boom");
    expect(await healthy).toBe("ok");
  });

  test("work a job submits waits for the next drain", async () => {
    // Given a job that submits more work as it runs
    const queue = new Queue();
    const order: string[] = [];
    let later: Promise<void> = Promise.resolve();
    void queue.submit(() => {
      order.push("first");
      later = queue.submit(() => {
        order.push("second");
        return Promise.resolve();
      });
      return Promise.resolve();
    });

    // Given the first drain ran only the job that was waiting
    await queue.drain();
    expect(order).toEqual(["first"]);

    // When the queue is drained again
    await queue.drain();
    await later;

    // Then the work that job submitted ran
    expect(order).toEqual(["first", "second"]);
  });

  test("a waiter is woken by the work that arrives", async () => {
    // Given a caller waiting for work to arrive
    const queue = new Queue();
    let arrived = false;
    void queue.pending.wait().then(() => {
      arrived = true;
    });

    // When work is submitted
    void queue.submit(() => Promise.resolve("done"));
    await Promise.resolve();

    // Then the waiter is woken, so a drain can be run for it
    expect(arrived).toBe(true);
  });

  test("work that arrives with nobody waiting still wakes the next waiter", async () => {
    // Given work submitted while nothing was waiting on the queue
    const queue = new Queue();
    void queue.submit(() => Promise.resolve("done"));

    // When a caller waits afterwards
    let arrived = false;
    void queue.pending.wait().then(() => {
      arrived = true;
    });
    await Promise.resolve();

    // Then it is woken by the work already sitting there
    expect(arrived).toBe(true);
  });

  test("a drained queue leaves the next waiter waiting", async () => {
    // Given a queue whose work has been drained
    const queue = new Queue();
    void queue.submit(() => Promise.resolve("done"));
    await queue.drain();

    // When a caller waits for more work to arrive
    let arrived = false;
    void queue.pending.wait().then(() => {
      arrived = true;
    });
    await Promise.resolve();

    // Then it waits, because the work it would have woken for is done
    expect(arrived).toBe(false);
  });

  test("closing the queue fails the work nobody will run", async () => {
    // Given a queue holding work
    const queue = new Queue();
    const pending = queue.submit(() => Promise.resolve("done"));

    // When the queue closes
    queue.close();

    // Then the waiting work fails, and so does anything submitted after
    await expect(pending).rejects.toThrow("the server has stopped ticking");
    await expect(queue.submit(() => Promise.resolve("late"))).rejects.toThrow(
      "the server has stopped ticking",
    );
  });
});
