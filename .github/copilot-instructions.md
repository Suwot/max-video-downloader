# PROJECT OVERVIEW

I'm building a Chrome MV3 extension which downloads HLS, DASH and direct video files. It uses native host for ffmpeg and ffprobe, packed with node.js. The goal is to make it run fast, providing best possible results.

The UI follows best UX/UI practices, with a focus on simplicity and beautiful styles/animations.

# CODING PREFERENCES

- Use ES6+ syntax and features, HTML5 and CSS3 standards.
- Always start by analyzing the flow pattern and compare it to best practices in the industry, only then analyze what needs to be changed and reason your decisions.
- Prefer reusing existing functions instead of creating new ones. Before creating new function, ask me for explicit confirmation.
- While substituting functions, completely remove the old and implement new one, don't leave thin wrappers
- Prefer simplicity over complexity. If a functions assigned 3+ roles, suggest how to split it into smaller functions, considering best flow practices in the industry.
- Plan your changes before coding.
- Stick to the requested and confirmed changes only. Stop and ask if you want to make an unapproved decision.
- Bring up optimization opportunities, especially for performance improvements.
- Separate implementation into small, manageable steps. I prefer code quality over writing speed.
- When proposing changes, provide brief comparison of the current and new code.
- Always weigh proposed changes by impact on performance and difficulty of implementation, show your estimation in the plan.
- Always look for ways to reduce the code size, by merging similar functions, reusing existing code, implementing only necessary changes, without overkill functionality.
- Use best modern practices, optimized for chrome extensions with native host communication.
- When working on multi-points plan, always stop after each point, before moving to the next step, explain what has been done, and what needs to be done next.
