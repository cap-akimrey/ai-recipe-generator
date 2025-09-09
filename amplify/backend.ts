import { defineBackend } from "@aws-amplify/backend";
import { data } from "./data/resource";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { bedrockFn } from "./functions/bedrock/resource";

const backend = defineBackend({ auth, data, bedrockFn });

// Grant the Lambda permission to call Bedrock
backend.bedrockFn.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    resources: [
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0",
    ],
    actions: ["bedrock:InvokeModel"],
  })
);
