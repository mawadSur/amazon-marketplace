#!/usr/bin/env node
// CDK entry point. Resolves config from context/env and instantiates the stack.

import { App, Tags } from "aws-cdk-lib";
import { resolveConfig } from "../lib/config.js";
import { MarketplaceStack } from "../lib/marketplace-stack.js";

const app = new App();
const config = resolveConfig(app);

const stack = new MarketplaceStack(app, `Shezmin-${config.stage}`, {
  config,
  env: { account: config.account, region: config.region },
  description: "Shezmin marketplace — VPC, ECS Fargate web+worker, RDS, Redis, S3, CDN.",
});

Tags.of(stack).add("app", "shezmin");
Tags.of(stack).add("stage", config.stage);
Tags.of(stack).add("managed-by", "cdk");
