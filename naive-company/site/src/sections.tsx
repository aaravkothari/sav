import type { ReactNode } from "react";
import type { SiteProfile } from "../site.config.ts";
import type { PublicPost } from "./profile.ts";

/** Every section renders the profile it is handed — the body of `GET /api/site` — and nothing else. */
export interface SectionProps {
  site: SiteProfile;
}

function Section({ id, eyebrow, title, subtitle, children }: {
  id: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="h2 mt-3 max-w-2xl">{title}</h2>
      {subtitle ? <p className="mt-3 max-w-2xl text-muted">{subtitle}</p> : null}
      <div className="mt-10">{children}</div>
    </section>
  );
}

const Bullet = ({ children }: { children: ReactNode }) => (
  <li className="flex gap-2">
    <span aria-hidden className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-accent" />
    {children}
  </li>
);

/** How the agency works — facts a visitor can hold it to. Never a result, a count or a client. */
export function ProofStrip({ site }: SectionProps) {
  return (
    <section aria-label="How we work" className="border-y border-line bg-white">
      <ul className="mx-auto grid max-w-6xl gap-4 px-6 py-8 text-sm font-medium sm:grid-cols-3">
        {site.proof.facts.map((fact) => (
          <li key={fact} className="flex gap-3">
            <span aria-hidden className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-accent" />
            {fact}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Services({ site }: SectionProps) {
  return (
    <Section id="services" eyebrow="Services" title="What we do">
      <div className="grid gap-5 md:grid-cols-3">
        {site.services.map((service) => (
          <article key={service.name} className="card p-7">
            <p className="eyebrow">{service.name}</p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight">{service.headline}</h3>
            <p className="mt-3 text-sm text-muted">{service.description}</p>
            <ul className="mt-5 space-y-2 text-sm">
              {service.deliverables.map((item) => <Bullet key={item}>{item}</Bullet>)}
            </ul>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function Blog({ site, posts }: SectionProps & { posts: PublicPost[] }) {
  if (posts.length === 0) return null;
  return (
    <Section
      id="insights"
      eyebrow="Insights"
      title="Search and answer-engine field notes"
      subtitle={`Practical guidance from ${site.company}, published only after operator review.`}
    >
      <div className="grid gap-5 md:grid-cols-3">
        {posts.map((post) => (
          <article className="rounded-xl border border-line bg-surface p-6" key={post.id}>
            <p className="eyebrow">{post.postedAt ?? post.scheduledFor}</p>
            <h3 className="mt-3 text-lg font-semibold tracking-tight">
              <a className="hover:text-accent" href={post.path}>{post.title}</a>
            </h3>
            <p className="mt-3 text-sm leading-6 text-muted">{post.summary}</p>
            <a className="mt-4 inline-block text-sm font-medium text-accent" href={post.path}>Read article →</a>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function WhoWeServe({ site }: SectionProps) {
  const { title, subtitle, segments } = site.whoWeServe;
  return (
    <Section id="who" eyebrow="Who we serve" title={title} subtitle={subtitle}>
      <div className="grid gap-5 md:grid-cols-3">
        {segments.map((segment) => (
          <article key={segment.name} className="card p-7">
            <h3 className="font-semibold">{segment.name}</h3>
            <p className="mt-2 text-sm text-muted">{segment.description}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function Process({ site }: SectionProps) {
  return (
    <Section id="process" eyebrow="Process" title={site.process.title} subtitle={site.process.subtitle}>
      <ol className="grid gap-5 md:grid-cols-4">
        {site.process.steps.map((step, i) => (
          <li key={step.title} className="card p-6">
            <span className="text-sm font-semibold text-accent">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="mt-2 font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm text-muted">{step.description}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function Pricing({ site }: SectionProps) {
  return (
    <Section id="pricing" eyebrow="Pricing" title={site.pricing.title} subtitle={site.pricing.subtitle}>
      <div className="grid gap-5 md:grid-cols-3">
        {site.pricing.tiers.map((tier) => (
          <article key={tier.name} className={`card p-7 ${tier.featured ? "outline-2 outline-accent" : ""}`}>
            <h3 className="font-semibold">{tier.name}</h3>
            <p className="mt-3 text-3xl font-semibold tracking-tight">
              {tier.price}
              <span className="text-sm font-normal text-muted">{tier.cadence}</span>
            </p>
            <p className="mt-3 text-sm text-muted">{tier.blurb}</p>
            <ul className="mt-5 space-y-2 text-sm">
              {tier.includes.map((item) => <Bullet key={item}>{item}</Bullet>)}
            </ul>
            <a href="#contact" className={`btn mt-7 w-full ${tier.featured ? "btn-accent" : "btn-ghost"}`}>
              {site.hero.cta}
            </a>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function Faq({ site }: SectionProps) {
  return (
    <Section id="faq" eyebrow="FAQ" title={site.faq.title}>
      <dl className="grid gap-5 md:grid-cols-2">
        {site.faq.items.map((item) => (
          <div key={item.question} className="card p-7">
            <dt className="font-semibold">{item.question}</dt>
            <dd className="mt-2 text-sm text-muted">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
