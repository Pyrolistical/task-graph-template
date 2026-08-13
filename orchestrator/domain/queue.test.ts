import { describe, expect, test } from "bun:test";
import { Queue } from "./queue.ts";

describe("Feature: edits applied one at a time", () => {
  test("submitted work runs without anyone draining it", async () => {
    // Given a queue nobody is watching
    const queue = new Queue();
    const order: string[] = [];

    // When work is submitted
    const submitted = queue.submit(() => {
      order.push("ran");
      return Promise.resolve("done");
    });

    // Then it runs, and the submitter gets its answer
    expect(await submitted).toBe("done");
    expect(order).toEqual(["ran"]);
  });

  test("a job still running holds up the ones behind it", async () => {
    // Given a queue running a job that has not finished
    const queue = new Queue();
    const order: string[] = [];
    let finish!: () => void;
    const running = new Promise<void>((resolve) => (finish = resolve));
    void queue.submit(async () => {
      order.push("first");
      await running;
    });
    const second = queue.submit(() => {
      order.push("second");
      return Promise.resolve();
    });

    // Given the job behind it has not started
    await Promise.resolve();
    expect(order).toEqual(["first"]);

    // When the running job finishes
    finish();
    await second;

    // Then the job behind it ran next
    expect(order).toEqual(["first", "second"]);
  });

  test("a job that fails is the only one that fails", async () => {
    // Given a failing job submitted before a healthy one
    const queue = new Queue();
    const failing = queue.submit(() => Promise.reject(new Error("boom")));
    const healthy = queue.submit(() => Promise.resolve("ok"));

    // When both have been run
    await queue.settled();

    // Then the failure reached its submitter and the next job still ran
    await expect(failing).rejects.toThrow("boom");
    expect(await healthy).toBe("ok");
  });

  test("settling waits for the work a job submits as it runs", async () => {
    // Given a job that submits more work as it runs
    const queue = new Queue();
    const order: string[] = [];
    void queue.submit(() => {
      order.push("first");
      void queue.submit(() => {
        order.push("second");
        return Promise.resolve();
      });
      return Promise.resolve();
    });

    // When the queue is settled
    await queue.settled();

    // Then both ran, in the order they were submitted
    expect(order).toEqual(["first", "second"]);
  });

  test("settling an idle queue returns", async () => {
    // Given a queue with nothing in it
    const queue = new Queue();

    // When it is settled
    await queue.settled();

    // Then it returns, with nothing left in flight
    expect(queue.inflight).toBe(0);
  });

  test("closing the queue refuses the work that comes after", async () => {
    // Given a queue that has closed
    const queue = new Queue();
    queue.close();

    // When work is submitted
    const late = queue.submit(() => Promise.resolve("late"));

    // Then it is refused rather than left waiting for a server that has gone
    await expect(late).rejects.toThrow("the server has stopped taking edits");
  });
});
