import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value, NodeState } from "../types";

interface Message {
  senderId: number;
  round: number;
  phase: 1 | 2;
  value: Value | null;
}

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };
  let running = false;
  const messages: { [key: string]: Message[] } = {};

  const broadcastMessage = async (round: number, phase: 1 | 2, value: Value | null) => {
    const message: Message = { senderId: nodeId, round, phase, value };
    if (!isFaulty && !state.killed) {
      const key = `${round}_${phase}`;
      if (!messages[key]) messages[key] = [];
      messages[key].push(message);
    }
    for (let i = 0; i < N; i++) {
      if (i === nodeId) continue;
      try {
        await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
      } catch (error) {
        // Ignore errors
      }
    }
  };

  const countMessages = (round: number, phase: 1 | 2, value: Value | null) => {
    const key = `${round}_${phase}`;
    return (messages[key] || []).filter((msg) => msg.value === value).length;
  };

  const runConsensus = async () => {
    if (isFaulty || state.k === null) return;

    if (N === 1 && !isFaulty) {
      console.log(`Node ${nodeId}: Single node, deciding immediately`);
      state.decided = true;
      return;
    }

    while (running && !state.decided) {
      const round: number = state.k;
      const minMessages = Math.max(1, N - F);
      const majorityThreshold = Math.ceil((N - F) / 2);

      await broadcastMessage(round, 1, state.x);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const phase1Key = `${round}_1`;
      let waitTime = 0;
      while ((messages[phase1Key] || []).length < minMessages && running && waitTime < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        waitTime += 10;
      }
      if (!running) break;

      let ones = countMessages(round, 1, 1);
      let zeros = countMessages(round, 1, 0);
      if (ones > N / 2) state.x = 1;
      else if (zeros > N / 2) state.x = 0;
      else state.x = "?";

      await broadcastMessage(round, 2, state.x);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const phase2Key = `${round}_2`;
      waitTime = 0;
      while ((messages[phase2Key] || []).length < minMessages && running && waitTime < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        waitTime += 10;
      }
      if (!running) break;

      ones = countMessages(round, 2, 1);
      zeros = countMessages(round, 2, 0);

      console.log(`Node ${nodeId} Round ${round} Phase 2: ones=${ones}, zeros=${zeros}, N=${N}, F=${F}, minMessages=${minMessages}, majorityThreshold=${majorityThreshold}, state=${JSON.stringify(state)}`);

      if (ones >= majorityThreshold && F < N / 2) {
        state.x = 1;
        state.decided = true;
      } else if (zeros >= majorityThreshold && F < N / 2) {
        state.x = 0;
        state.decided = true;
      } else if (ones > zeros && ones >= minMessages - 1) {
        state.x = 1;
      } else if (zeros > ones && zeros >= minMessages - 1) {
        state.x = 0;
      } else if (F >= N / 2) {
        state.x = Math.random() < 0.5 ? 0 : 1;
      } else {
        state.x = ones > zeros ? 1 : 0;
      }

      state.k = round + 1;
    }
  };

  node.get("/status", (req, res) => {
    if (isFaulty) res.status(500).send("faulty");
    else res.status(200).send("live");
  });

  node.post("/message", (req, res) => {
    if (isFaulty || state.killed) {
      res.status(200).send();
      return;
    }
    const message: Message = req.body;
    const key = `${message.round}_${message.phase}`;
    if (!messages[key]) messages[key] = [];
    messages[key].push(message);
    res.status(200).send();
  });

  node.get("/start", async (req, res) => {
    if (isFaulty || state.killed) {
      res.status(200).send();
      return;
    }
    if (!running) {
      running = true;
      runConsensus();
    }
    res.status(200).send();
  });

  node.get("/stop", async (req, res) => {
    running = false;
    state.killed = true;
    res.status(200).send();
  });

  node.get("/getState", (req, res) => {
    res.json(state);
  });

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}