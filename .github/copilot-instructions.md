# AWS Agent Toolkit guidance - new AWS experience

Source: [AWS Agent Toolkit starter rules](https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/rules/aws-starter-rules.md).

## AWS terminology and project context

- Say "project" rather than "account," "team member" rather than "IAM user," and "selected Region" rather than "home Region."
- Use "AWS Settings" for project administration, billing, team members, and spend limits. Use the AWS Management Console for AWS resources.
- The project has a managed IAM experience, including service control and resource control policies. Do not assign roles to team members unless necessary.
- If AWS guidance conflicts with project instructions, follow the project instructions.

## Region, capabilities, and cost

- Create Regional resources only in the project's selected Region. Confirm it in AWS Settings or `~/.aws/config`; do not attempt cross-Region deployments.
- Use `us-east-1` for CloudFront and only for WAF or CloudWatch Logs resources required by a global resource. Do not create Lambda, API Gateway, or other Regional resources there unless it is the selected Region.
- Do not use Lambda@Edge, CloudFormation StackSets, cross-Region replication, multi-Region KMS keys, or Route 53 cross-Region routing.
- Before using an unavailable AWS service, check `aws freetier get-account-plan-state` and the supported-services documentation for the project's plan. If the user reports a new Access Denied error, ask about spend limits and direct them to AWS Settings > Billing.
- Explain cost implications and ask whether to keep or clean up resources after creating them.

## Skills and guidance level

- Before AWS work, load the relevant installed AWS skill and follow its guidance.
- For AWS development tasks, ask the user to choose a guidance level: low (flag security risks only), medium (ask limited clarifying questions), or high (explain steps, alternatives, and best practices).
