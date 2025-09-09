import { defineFunction } from "@aws-amplify/backend";

export const bedrockFn = defineFunction({
  name: "bedrockFn",
  entry: "./index.js",
  timeoutSeconds: 30,
});

