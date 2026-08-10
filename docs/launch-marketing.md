# Lampwright launch and community marketing

Status: launch plan researched 2026-08-10. This document records recommendations,
not authorization to publish the npm package, announce the project, or contact a
community.

## Recommendation

Lampwright does not need a large personal following. Its best distribution path is
to demonstrate a specific problem to communities that already have it:

1. publish and verify the npm package;
2. make the GitHub and npm pages excellent conversion surfaces;
3. launch with one substantive Show HN post and one or two carefully tailored
   Reddit posts;
4. publish a durable technical article on DEV;
5. share harness-specific demonstrations in first-party developer communities;
6. use X and LinkedIn to amplify those artifacts, not as the primary source of
   discovery;
7. consider Product Hunt after the first users have exercised installation and
   recovery.

The positioning should be concrete:

> Lampwright gives people who use multiple AI coding harnesses one live inventory
> of their Skills, with reversible disable/enable controls and safety-first
> removal.

Lead with the multi-harness problem and reversibility. Do not lead with “cleaning,”
generic AI productivity, or unverified token-cost savings.

## Hard launch gate

Do not market a command that people cannot successfully run. As of 2026-08-10,
`lampwright` is not present in the npm registry, the GitHub repository has no
release, and its README correctly describes npm publication as future work.

Before any broad announcement:

- publish the explicitly approved version with provenance;
- from clean temporary directories on macOS, Linux, and Windows, verify both the
  exact release and the friendly command, including the interactive TUI:

  ```console
  npx --yes lampwright@0.1.0 --version
  npx --yes lampwright@0.1.0 --help
  npx lampwright
  ```

- confirm that the npm package links back to the correct public repository;
- create a GitHub release with human-readable notes and the tested install command;
- have a response path ready for bugs and security reports.

`npx` installs a missing package into npm's cache and adds its executable to
`PATH`, so testing outside a checkout is important; otherwise a local dependency
can mask a packaging failure. See the official [`npx` behavior](https://docs.npmjs.com/cli/commands/npx/).

## Launch package

Prepare these once, then adapt them to each channel:

- a 30–60 second terminal recording showing inventory, disable, Disabled view,
  enable, safe remove, Trash, and restore;
- a shorter 10–15 second loop for social posts;
- the existing social card plus two clean TUI screenshots;
- a support matrix for macOS, Linux, Windows and each detected harness;
- a one-screen explanation of the safety model: live inventory, protected System
  Skills and Git content, managed removal first, and recoverable fallback;
- a copyable install command near the top of the README;
- a concise “why I built it” paragraph and one narrow feedback question;
- release notes with known limitations instead of launch-copy superlatives.

The demo should show the actual terminal, not a narrated slide deck. A viewer should
understand the problem, see a reversible action, and reach the install command in
under a minute.

## Channel order and rules

### 1. GitHub and npm: make discovery convert

Do this immediately before launch. GitHub says topics help people find and
contribute to a project; Lampwright currently has no repository topics. Add a
small, accurate set such as `ai-agents`, `agent-skills`, `claude-code`, `codex`,
`gemini-cli`, `terminal-ui`, `cli`, `typescript`, and `developer-tools`. Topics are
searchable and should describe purpose, subject, community, or language, with a
maximum of 20. See [GitHub's topic guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

Create the first GitHub release at the same time as npm publication. GitHub
releases package a deployable iteration, attach it to a tag, provide release
notes, and let users subscribe specifically to releases. See
[GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Keep the uploaded social preview: GitHub uses it when repository links are shared
and recommends a solid PNG/JPG/GIF under 1 MB, ideally 1280×640. See
[GitHub social previews](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

### 2. Show HN: strongest single launch opportunity

Lampwright is a good Show HN fit after `npx` works: it is non-trivial software that
people can run locally without signup. The title should be factual, for example:

> Show HN: Lampwright – reversibly manage AI agent Skills across coding harnesses

Link directly to GitHub. Add a first comment written personally that explains the
multi-harness problem, the safety design, what is implemented, known limitations,
and the specific feedback wanted. Be available to answer technical questions.

The official [Show HN guidelines](https://news.ycombinator.com/showhn.html) require
something the community can try, personal involvement by the author, and no
barriers such as signup. They also prohibit asking friends for votes or comments.
HN currently warns unfamiliar users to first become good community contributors
before posting an occasional Show HN; check the current
[Show HN restriction notice](https://news.ycombinator.com/showlim) before launch.
HN also says not to use the site primarily for promotion and not to solicit votes
or comments. See the [general HN guidelines](https://news.ycombinator.com/newsguidelines.html).

### 3. Reddit: use two tailored posts, not a launch blast

Reddit itself says promotional content is not inherently spam, but repeated or
unsolicited mass engagement is, and community moderators decide their local
rules. Post authentic, human-written content only where it is directly relevant;
do not paste the same announcement into many communities. When rules are unclear,
ask moderators first. See [Reddit's current spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)
and [promotion guidance for moderators](https://support.reddithelp.com/hc/en-us/articles/28012014962580-How-do-I-keep-spam-out-of-my-community).

Recommended targets:

- **r/ClaudeCode:** high fit. Its current
  [community rules](https://www.reddit.com/r/ClaudeCode/about/rules.json) allow
  tools/resources when the post states what they do, who benefits, cost, and the
  poster's relationship. Use the proper flair, disclose “I built this,” and show a
  Claude Code workflow.
- **r/ClaudeAI:** high fit but gated. Its
  [rules](https://www.reddit.com/r/ClaudeAI/about/rules.json) require the poster to
  explain what was built, how Claude helped or how it is for Claude, what it does,
  and how it is free to try; marketing language must be minimal. Feed posts also
  require more than 50 OP karma. Build community history before posting.
- **r/ChatGPTCoding:** medium/high fit for a Codex-oriented walkthrough. Its
  [rules](https://www.reddit.com/r/ChatGPTCoding/about/rules.json) require a
  build post to add community value rather than merely drive traffic. Check the
  current [promotion wiki/thread](https://www.reddit.com/r/ChatGPTCoding/about/wiki/promotion/)
  at posting time because some details are login-gated.
- **r/opensource:** medium fit. Its
  [rules](https://www.reddit.com/r/opensource/about/rules.json) allow restrained
  self-promotion (under 10% is the stated guideline) with Promotional flair, a
  recognized open-source license, and real participation. The founder must write
  the post personally; the community treats AI-generated posts as low effort.

Skip or defer:

- **r/commandline:** do not submit Lampwright. Its current
  [rules](https://www.reddit.com/r/commandline/about/rules.json) explicitly exclude
  generative-AI-related projects except already-popular projects.
- **r/programming:** not a launch channel. Its
  [rules](https://www.reddit.com/r/programming/about/rules.json) prohibit direct
  project promotion/demo/feedback posts; only a genuinely deep technical article
  about the implementation might fit.
- **r/LocalLLaMA:** use only if Lampwright develops a concrete local-model harness
  use case. Its [rules](https://www.reddit.com/r/LocalLLaMA/about/rules.json) require
  LLM relevance, disclosure, participation, and restrained self-promotion.
- **r/codex:** its [published rules](https://www.reddit.com/r/codex/about/rules.json)
  require direct Codex relevance but do not establish a clear promotion route.
  Ask moderators before posting.

Launch the Reddit posts on different days. Each should teach a workflow native to
that community and end with a real question such as “Which Skill location or
harness am I missing?” rather than “Please star this.”

### 4. DEV Community: durable technical discovery

Write an article, not a link post. A suitable angle is:

> How I made deleting AI agent Skills reversible across five coding harnesses

Explain the ownership problem, live inventory, System Skill protection, native
disable versus safe suspension, Trash/restore, and cross-platform edge cases.
Include the demo and repository link naturally. DEV requires substantial,
on-topic content that is not primarily promotion or backlink creation. See its
[content policy](https://dev.to/terms#11-content-policy).

DEV permits drafts, scheduling, cover images, and canonical URLs; its editor
supports up to four tags and recommends a 1000×420 cover. See the official
[writing guide](https://dev.to/help/writing-editing-scheduling) and
[editor reference](https://dev.to/p/editor_guide/). Reasonable tags are `ai`,
`opensource`, `typescript`, and `cli` if each exists and fits at publication time.

### 5. First-party developer communities: feedback, not syndication

Create separate, harness-specific demonstrations rather than cross-posting one
generic announcement:

- The [OpenAI Developer Community guidelines](https://community.openai.com/guidelines)
  welcome relevant things members built, but prohibit repetitive or overly
  promotional posts and cross-posting. Share a Codex-specific workflow in one
  appropriate category.
- Anthropic's official Claude Code repository directs developers to the
  [Claude Developers Discord](https://github.com/anthropics/claude-code#connect-on-discord)
  to get help, share feedback, and discuss projects. Public promotion/channel
  rules were not verifiable, so read the server rules and ask moderators before
  linking Lampwright.
- The Google AI Developers Forum has a Community category for tips and cool
  projects, but its [guidelines](https://discuss.ai.google.dev/guidelines) prohibit
  spam and require relevance to Google AI developer offerings. Post only a real
  Gemini CLI workflow and check category rules first.

### 6. Product Hunt: optional second wave

Product Hunt can supply discovery without an existing following, but it is better
after installation has been validated by early users. Lampwright is a live digital
developer product and therefore eligible; current featuring guidance prioritizes
useful, novel, high-craft, creative products that are available to use. See
[Product Hunt's 2026 featuring criteria](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines).

Self-hunt from a personal account. A famous hunter is unnecessary: Product Hunt
actively encourages self-hunting, but new accounts must wait at least one week and
it recommends joining well ahead of launch. See
[before-launch guidance](https://www.producthunt.com/launch/before-launch) and
[how Product Hunt works](https://www.producthunt.com/launch/how-product-hunt-works).

Prepare a direct GitHub URL, short tagline, accurate “free” pricing, a square
thumbnail (240×240 recommended), at least two gallery images (1270×760
recommended), a terminal demo, concise description, and a substantive maker first
comment. Product Hunt launches operate in Pacific-time day windows; schedule for a
day when the maker can be present rather than chasing an alleged magic weekday.
See [submission fields and sizes](https://help.producthunt.com/en/articles/479557-how-to-post-a-product)
and [launch preparation](https://www.producthunt.com/launch/preparing-for-launch).

Never buy a hunter, traffic, votes, or comments, and never reward upvotes.
Product Hunt says those tactics can cause removal or a permanent ban.

## Suggested sequence

### Before release

1. Open accounts and participate genuinely in the two communities most likely to
   receive a launch post.
2. Add GitHub topics and finish the release-facing README.
3. Record the demo against the exact package tarball/release candidate.
4. Draft Show HN, Reddit, and DEV copy independently and personally.

### Release day

1. Publish npm and the GitHub release.
2. Run the clean-machine install matrix.
3. Fix packaging or first-run problems before announcing anything.
4. Make a modest X/LinkedIn post so existing contacts can find the release; do not
   ask for coordinated voting elsewhere.

### Following two weeks

1. Submit Show HN when the author can remain available.
2. Publish one tailored Reddit post, respond fully, and incorporate feedback.
3. Publish the DEV technical article.
4. Share one harness-specific post in an appropriate first-party community.
5. Publish the second Reddit post only if it has a distinct workflow and audience.
6. Decide whether Product Hunt is worth a second-wave launch after observing
   installation failures, questions, and retention.

## Measure learning, not vanity

For the first launch, track:

- successful clean installs and first-run bug reports;
- GitHub traffic sources, clones, stars, and unique visitors;
- npm weekly downloads, interpreted cautiously because automated installs exist;
- issues that reveal missing harnesses, unsafe assumptions, or confusing language;
- demo completion/click-through where the platform provides it;
- helpful comments and repeat users, not leaderboard position alone.

GitHub's repository graphs include Traffic, Pulse, contributors, forks, and other
activity views that can help interpret launch response. See
[GitHub repository graphs](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/about-repository-graphs).

The most valuable launch result is a small group of multi-harness users willing to
test disable, enable, Trash, and restore—not a large audience that never runs the
tool.
