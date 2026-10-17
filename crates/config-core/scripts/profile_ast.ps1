$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -eq 'secureDirectory') {
        # 在存放任何配置备份前关闭权限继承，仅保留当前用户和 SYSTEM。
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $currentSid = $identity.User.Value
        try {
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sid in @($identity.User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                    $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
                $acl.AddAccessRule($rule)
            }
            Set-Acl -LiteralPath $request.path -AclObject $acl
        } finally { $identity.Dispose() }
        @{ sid = $currentSid } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.Write($_) }
        exit 0
    }
    if ($request.action -ne 'parse') { throw '不支持的辅助操作。' }
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        [string]$request.text, [ref]$tokens, [ref]$parseErrors)
    $aliases = [System.Collections.Generic.List[object]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    $errors = @($parseErrors | ForEach-Object { "第 $($_.Extent.StartLineNumber) 行 PowerShell 语法错误。" })
    $nodes = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
        ($node -is [System.Management.Automation.Language.CommandAst] -and
            $node.GetCommandName() -eq 'Register-CodexCommand')
    }, $true)
    foreach ($node in $nodes) {
        if ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            if ($node.Name -notmatch '^claude-') { continue }
            $statements = @($node.Body.EndBlock.Statements)
            $command = if ($statements.Count -eq 1 -and
                $statements[0] -is [System.Management.Automation.Language.PipelineAst] -and
                $statements[0].PipelineElements.Count -eq 1) { $statements[0].PipelineElements[0] } else { $null }
            $elements = if ($command -is [System.Management.Automation.Language.CommandAst]) { @($command.CommandElements) } else { @() }
            $topLevel = $node.Parent -is [System.Management.Automation.Language.NamedBlockAst] -and $node.Parent.Parent -eq $ast
            if (-not $topLevel -or $elements.Count -ne 4 -or $command.GetCommandName() -ne 'claude' -or
                $elements[1].Extent.Text -ne '--settings' -or
                $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $elements[3] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
                -not $elements[3].Splatted -or $elements[3].VariablePath.UserPath -ne 'args') {
                $warnings.Add("别名 $($node.Name) 不是受支持的静态函数，自动修改 profile 已禁用。")
                continue
            }
            $aliases.Add(@{ name = $node.Name; path = $elements[2].Value; kind = 'claude'
                start = $node.Extent.StartOffset; end = $node.Extent.EndOffset })
        } else {
            $elements = @($node.CommandElements)
            $pipeline = $node.Parent
            $topLevel = $pipeline -is [System.Management.Automation.Language.PipelineAst] -and
                $pipeline.PipelineElements.Count -eq 1 -and
                $pipeline.Parent -is [System.Management.Automation.Language.NamedBlockAst] -and $pipeline.Parent.Parent -eq $ast
            if (-not $topLevel -or $elements.Count -ne 3 -or
                $elements[1] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $elements[1].Value -notmatch '^(codex|codexnew)-[A-Za-z0-9._-]+$') {
                $warnings.Add('存在动态或不支持的 Codex 注册，自动修改 profile 已禁用。')
                continue
            }
            $aliases.Add(@{ name = $elements[1].Value; path = $elements[2].Value; kind = 'codex'
                start = $node.Extent.StartOffset; end = $node.Extent.EndOffset })
        }
    }
    foreach ($group in @($aliases | Group-Object { $_.name.ToLowerInvariant() } | Where-Object Count -gt 1)) {
        $warnings.Add("存在重复别名 $($group.Name)，自动修改 profile 已禁用。")
    }
    @{ aliases = @($aliases.ToArray()); warnings = @($warnings.ToArray()); errors = @($errors) } |
        ConvertTo-Json -Depth 12 -Compress | ForEach-Object { [Console]::Out.Write($_) }
} catch {
    # 不把用户配置文本带入标准错误或日志。
    [Console]::Error.Write('配置辅助操作失败。')
    exit 1
}
