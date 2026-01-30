# GitHub

GitHub MCP provides comprehensive access to your GitHub repositories, issues, pull requests, projects, and more.

## Scope

This source provides access to:
- **Repositories**: Search, browse, and manage repositories
- **Issues**: Create, search, update, and manage issues
- **Pull Requests**: View, create, review, and merge PRs
- **Projects**: Manage GitHub Projects and project items
- **Code Search**: Search code across repositories
- **Branches & Commits**: View and manage branches, commits, and refs
- **Organizations**: Work with organization resources
- **Workflows**: Interact with GitHub Actions workflows

## Guidelines

### Authentication
- Requires a Personal Access Token (PAT) with appropriate scopes
- Recommended scopes: `repo`, `read:org`, `read:user`, `project`, `workflow`
- Create a PAT at: https://github.com/settings/tokens

### Best Practices
- Use specific repository context when searching to narrow results
- Be mindful of rate limits (5,000 requests/hour for authenticated users)
- For large operations, consider batching requests
- Always specify the full repository path as `owner/repo`

### Common Patterns

**Search for issues:**
```
Find open issues in the kata-agents repository
```

**View pull requests:**
```
Show me recent pull requests in gannonh/kata-agents
```

**Search code:**
```
Search for "OAuth" in the codebase
```

**Create issues:**
```
Create an issue in my-org/my-repo for the bug I just found
```

## Available Tools

The GitHub MCP server provides tools for:
- Repository operations (list, get, create, fork)
- Issue management (create, update, search, list, add comments)
- Pull request workflows (create, update, merge, review)
- Project management (create items, update fields)
- Code search and file operations
- Branch and commit operations
- Organization management

## Rate Limits

- **Authenticated requests**: 5,000/hour
- **Search API**: 30 requests/minute
- Monitor rate limits with the `get_rate_limit` tool

## References

- [GitHub MCP Server Documentation](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Creating Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
