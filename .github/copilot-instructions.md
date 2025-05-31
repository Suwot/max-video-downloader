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
- when you need to substitute a function, first perform a search in the codebase via terminal command to quickly find all instances and decide on the best approach to quickly and reliably update all of them
- when you reference any files (existing or new), use VSCode hyperlink format
- when there are multiple ways to achieve the same goal, always give me relevant options to choose from and explain the pros and cons of each option
- always show affected file name in the comment on the first line of each code snippet

- show me concise code snippets, without irrelevant context to the task at hand

- when you make/propose changes, at the end include structured Summary of Changes:
  - **File changed**([filename)](path/to/file)):
  - unordered list of changes made/proposed
    - change 1
    - change 2
  - summary in 1 line
