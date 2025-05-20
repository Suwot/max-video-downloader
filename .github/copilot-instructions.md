## PROJECT OVERVIEW

It's a **Chrome MV3 extension** designed to download **HLS**, **DASH**, and **direct video/audio**. It communicates with a **Node.js-powered native host** bundled with `ffmpeg` and `ffprobe` for efficient media processing.

The UI follows **modern UX/UI standards**: minimal, responsive, fast, and clean—with proper animation and structural clarity.

## CODING STANDARDS

- reuse existing code, instead of creating new code
- strive for streamlining data flow and function calls patterns
- general flow robustness and simplicity is my priority
- always keep in mind best practices in the industry
- when substituting functions, avoid creating thin wrappers
- think out of the box when looking for solutions
- analyze current data flow and function call stack before jumping to conclusions
- strive for simple solutions, avoid complexity
- always add precise data instead of mock values, use null for missing info instead of empty strings or 0, when appropriate
- use ES6+ syntax, HTML5, CSS3, and JS best practices
- critically evaluate all input and corrections from me, I might be mistaken, confused or even wrong and mislead you, stay focused on best practices and the project goals

## STRUCTURE OF YOUR ANSWERS

- give me a brief answer (reason, what to do, why it will solve my request)
- create an implementation plan with this structure:
- short plan overview (changes + reasons)

  then for each point:

  - ordered ## header for title
  - what you want to do and why it will work (call it Solution)
  - comparison of suggestion to existing logic (call it Explanation)
  - Pros & Cons (critical evaluation of your suggestion)
  - evaluation in one line: difficulty + overall impact (in 0-10 scale)
  - code snippet of the current code + brief explanation what it does above the snippet
  - code snippet of the proposed code + brief explanation what it will do above the snippet

  Avoid repeating yourself, show me insights and groud your suggestions in the context of the project.
