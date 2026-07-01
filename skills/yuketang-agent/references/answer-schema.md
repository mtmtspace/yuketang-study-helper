# Answer Schema

Write a UTF-8 JSON file. Use exact `index` values from the dump log whenever possible.

## Recommended Shape

```json
{
  "items": [
    {
      "index": "1",
      "answer": ["A"],
      "reason": "short optional reason"
    },
    {
      "index": "Chapter3#2",
      "answer": ["B", "D"],
      "reason": "multiple choice: include all correct letters"
    },
    {
      "index": "T or F Questions Chap 7 - Valuation#1",
      "answers": ["true"],
      "reason": "fill blanks use strings, not choice letters"
    }
  ]
}
```

The script also accepts a top-level array, or an object map:

```json
{
  "answers": {
    "1": ["A"],
    "2": ["C"]
  }
}
```

## Choice Questions

- Use option letters from the dump record.
- Single choice and judge: exactly one letter, for example `["B"]`.
- Multiple choice: one or more letters, for example `["A", "C"]`.
- Do not write option text if a letter is available.

## Fill Blanks

- Use `answers` as an array in blank order.
- Match the dump record's `blankCount`.
- For true/false fill blanks, use lowercase English strings: `"true"` or `"false"`.
- For finance/numeric answers, write the literal text that should be filled into the input box.

## Matching Rules

The apply pass first matches by exact `index`, then by `id`, `questionId`, or `key`. Single-homework dumps usually use `1`, `2`, etc. Course homework and quiz papers usually use `Title#1`, `Title#2`, etc.

Avoid relying on short numeric indexes when multiple homework papers are handled in one pass; exact `index` is safer.
