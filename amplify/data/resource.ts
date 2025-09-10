import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { bedrockFn } from "../functions/bedrock/resource";

const schema = a.schema({
  BedrockResponse: a.customType({
    body: a.string(),
    error: a.string(),
    imageBase64: a.string(),
    imageMimeType: a.string(),
  }),
  askBedrock: a
    .query()
    .arguments({ ingredients: a.string().array() })
    .returns(a.ref("BedrockResponse"))
    .authorization((allow) => [allow.authenticated('userPools')])
    .handler(a.handler.function(bedrockFn)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
