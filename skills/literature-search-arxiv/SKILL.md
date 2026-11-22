---
name: literature-search-arxiv
description: "arXiv-specific search and retrieval with arXiv rate limits: query by arXiv field syntax or ID, and download a paper's PDF, HTML or LaTeX source. Use when the user names arXiv or gives an arXiv ID; reading a paper from its LaTeX source: read-arxiv; general literature searches go to paper-lookup."
---

# arXiv Search and Retrieval

## Prerequisites

-   Run the scripts with the system `python3` by their full path (`<skill-dir>/scripts/<script>.py`)
    so outputs land in the user's working directory. They import `polite_http` (per-host rate
    limiting, retries, backoff), which ships inside `scripts/` — nothing to install.
-   From remote hosts arXiv PDF and source downloads can be slow (roughly 15–50 KB/s, so a
    2 MB PDF takes one to three minutes); run them with a command timeout of several minutes.
-   Name arXiv as the data source when presenting results; its terms of use are at
    https://info.arxiv.org/help/api/index.html;
    remind the user to check the license of retrieved papers before reusing them.

## Core Rules

-   **Terms of Use**: You MUST respect arXiv's Terms of Use.
    -   Maximum 1 request every 3 seconds.
    -   The provided utility scripts handle rate limiting automatically. Always
        use these scripts rather than writing your own curl/python requests.
-   List the URLs of all papers that were used in producing the output.
-   **Verify IDs before citing**: Never guess, extrapolate, or cite an arXiv ID from memory. Before referencing any arXiv ID, verify via `search_arxiv.py` (`--id_list` or query metadata) or downloaded HTML/LaTeX/extracted text that the ID matches the paper's actual title and authors.
-   **No direct binary PDF reads**: Do NOT call standard text `Read` tools directly on downloaded `.pdf` binaries (blocked by harness guards). Prefer `--format html` via `download_paper.py` or LaTeX source via `download_paper_source.py`; if only a PDF is available, extract plain text via a dedicated extraction script (`pdftotext` or a Python PDF parser) before reading.

## Utility Scripts

**1. Search and Extract Metadata**

Search arXiv and return a clean JSON array of matching papers.

```bash
python3 <skill-dir>/scripts/search_arxiv.py --query "au:einstein AND ti:relativity" \
  --max_results 5 2>/dev/null > /tmp/arxiv_search_results.json
```

> **Important**: The tool outputs a large JSON result to stdout. Requesting 100+
> results will produce a massive JSON that might exceed your context length.
> Limit `--max_results` (e.g., 5-10) or paginate carefully using `--start`.
> Always redirect output to a file and parse it separately, otherwise terminal
> output will be truncated.

*Returned Metadata:* JSON results include `id`, `title`, `summary`, `published`,
`authors`, `pdf_url`, `primary_category`, `doi`, `journal_ref`, and `comment`.
Note: the `doi` field only contains DOI information in case the paper has an
external DOI and if only an arXiv-issued DOI exists, this is DOI is not
returned.

*Options:*

-   `--query`: Search string. See
    [references/query_syntax.md](references/query_syntax.md) for advanced
    syntax.
-   `--id_list`: Comma-separated list of arXiv IDs to fetch directly (e.g.,
    `1706.03762v5`).
-   `--start`: Pagination offset (default 0).
-   `--max_results`: Number of results to return (default 10).
-   `--sort_by`: `relevance`, `lastUpdatedDate`, or `submittedDate`. (Use
    `--sort_by submittedDate --sort_order descending` for the most recent
    papers).
-   `--sort_order`: `ascending` or `descending`.

**2. Download Paper (PDF or HTML)**

Download the full text of a paper to your local workspace for reading.

```bash
python3 <skill-dir>/scripts/download_paper.py --id 1706.03762 --format pdf --output attention.pdf
```

*Options:*

-   `--id`: The arXiv ID (e.g., `1706.03762` or `1706.03762v5`).
-   `--format`: `pdf` or `html`. Note: HTML is only available for newer papers.
-   `--output`: Filepath to save the downloaded document.

> **Important**: when downloading papers, make sure you download them to a
> location where you do not overwrite other files and do not clutter existing
> directory structure.

**3. Download Paper Source (tar.gz)**

Download the LaTeX source files of a paper to your local workspace. Note that
not all papers have source available.

```bash
python3 <skill-dir>/scripts/download_paper_source.py --id 2010.11645 --output source.tar.gz
```

*Options:*

-   `--id`: The arXiv ID (e.g., `2010.11645`).
-   `--output`: Filepath to save the downloaded tar.gz file.

> **Caution**: Care should be exercised when untar'ing the downloaded file for
> security and to avoid cluttering your filesystem, as archives may contain many
> files or unexpected directory structures.
>
> **Safe Extraction Requirements**: NEVER extract directly into your working
> directory! Always extract into a dedicated new directory: `mkdir
> paper_source && tar -xzf source.tar.gz -C paper_source`

## Reference

-   **Advanced Query Syntax**: See
    [references/query_syntax.md](references/query_syntax.md) for prefixes (au,
    ti, abs), booleans, and date filtering.

## Workflow

1.  Search for papers using `search_arxiv.py`. Review the JSON summaries.
2.  Verify every candidate arXiv ID against returned metadata (title, authors, summary) or downloaded content before downloading or citing it.
3.  When full text is needed, prefer HTML (`download_paper.py --format html`) or LaTeX source (`download_paper_source.py`); download PDF only as fallback and verify the file is non-empty.
4.  Read downloaded HTML or extracted LaTeX files directly; never call standard `Read` on raw `.pdf` binaries — run a dedicated text extraction script (`pdftotext` or a Python PDF extractor) first and read the extracted text.
