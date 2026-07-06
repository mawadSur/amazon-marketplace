// Edge layer: ACM cert + CloudFront distribution fronting the internal ALB via
// a CloudFront VPC origin, plus Route53 alias records. Only instantiated when a
// domainName + hostedZoneId are provided in context.

import { Construct } from "constructs";
import {
  Duration,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as route53,
  aws_route53_targets as targets,
} from "aws-cdk-lib";

export interface EdgeProps {
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly alb: elbv2.ApplicationLoadBalancer;
}

export class Edge extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    const { domainName, hostedZoneId, alb } = props;
    const wwwDomain = `www.${domainName}`;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId,
      zoneName: domainName,
    });

    // CloudFront requires the cert in us-east-1. When the stack itself is not in
    // us-east-1, enable crossRegionReferences on the stack (see marketplace-stack).
    const certificate = new acm.Certificate(this, "Cert", {
      domainName,
      subjectAlternativeNames: [wwwDomain],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // VPC origin lets CloudFront reach the *internal* ALB privately.
    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      domainNames: [domainName, wwwDomain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // SSR — app owns caching
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        // Static Next assets are immutable + content-hashed → cache hard.
        "/_next/static/*": {
          origin: vpcOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const target = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    );
    new route53.ARecord(this, "ApexA", { zone, target, ttl: Duration.minutes(5) });
    new route53.AaaaRecord(this, "ApexAAAA", { zone, target });
    new route53.ARecord(this, "WwwA", { zone, recordName: "www", target });
    new route53.AaaaRecord(this, "WwwAAAA", { zone, recordName: "www", target });
  }
}
