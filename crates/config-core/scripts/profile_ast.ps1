$ErrorActionPreference = 'Stop'
$panelStage = 'initialize_io'
$panelAction = 'unknown'
$panelReader = $null
$panelWriter = $null
$panelErrorWriter = $null

# 此模块只解析 profile；标准输入输出直接使用 UTF-8 管道。
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $panelErrorWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardError(), $utf8)
    $panelErrorWriter.AutoFlush = $true
    $panelWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $panelWriter.AutoFlush = $true
    $panelReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $panelStage = 'read_request'
    $request = ConvertFrom-Json -InputObject $panelReader.ReadToEnd()
    $panelAction = [string]$request.action
    $panelStage = 'validate_request'
    if ($request.action -ne 'parse') { throw 'ACTION_NOT_SUPPORTED' }
    $panelStage = 'parse_profile'
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
                # 结构异常时携带精确文件位置与原文，避免用户在长 profile 中茫然查找。
                $where = if ($node.Extent.StartLineNumber -gt 0) {
                    "profile 第 $($node.Extent.StartLineNumber) 行：$($node.Extent.Text)"
                } else { $node.Extent.Text }
                $warnings.Add("别名 $($node.Name) 不是受支持的静态函数，自动修改 profile 已禁用。位置：$where")
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
                # \w 在 PowerShell 正则中是 Unicode 语义，放行中文别名；结构异常时携带精确位置。
                $elements[1].Value -notmatch '^(codex|codexnew)-[\w.-]+$') {
                $where = if ($node.Extent.StartLineNumber -gt 0) {
                    "profile 第 $($node.Extent.StartLineNumber) 行：$($node.Extent.Text)"
                } else { $node.Extent.Text }
                $warnings.Add("存在动态或不支持的 Codex 注册，自动修改 profile 已禁用。位置：$where")
                continue
            }
            $aliases.Add(@{ name = $elements[1].Value; path = $elements[2].Value; kind = 'codex'
                start = $node.Extent.StartOffset; end = $node.Extent.EndOffset })
        }
    }
    foreach ($group in @($aliases | Group-Object { $_.name.ToLowerInvariant() } | Where-Object Count -gt 1)) {
        $warnings.Add("存在重复别名 $($group.Name)，自动修改 profile 已禁用。")
    }
    $panelStage = 'serialize_result'
    $result = @{ aliases = @($aliases.ToArray()); warnings = @($warnings.ToArray()); errors = @($errors) }
    $panelWriter.WriteLine((ConvertTo-Json -InputObject $result -Depth 12 -Compress))
} catch {
    # 保留完整错误正文和脚本堆栈，便于直接定位实际失败原因。
    $record = $_
    $cause = $record.Exception
    for ($depth = 0; $depth -lt 8 -and $null -ne $cause.InnerException; $depth++) {
        $cause = $cause.InnerException
    }
    $nativeCode = $null
    if ($cause -is [System.ComponentModel.Win32Exception]) { $nativeCode = $cause.NativeErrorCode }
    $failure = @{
        action = $panelAction; stage = $panelStage
        exceptionType = $cause.GetType().FullName; errorId = $record.FullyQualifiedErrorId
        message = $record.ToString(); stackTrace = [string]$record.ScriptStackTrace
        line = [int]$record.InvocationInfo.ScriptLineNumber
        hresult = $cause.HResult; nativeCode = $nativeCode
    }
    if ($null -eq $panelErrorWriter) {
        $panelErrorWriter = [System.IO.StreamWriter]::new(
            [Console]::OpenStandardError(), [System.Text.UTF8Encoding]::new($false))
        $panelErrorWriter.AutoFlush = $true
    }
    $panelErrorWriter.WriteLine()
    $panelErrorWriter.WriteLine('CLI_AUTO_PANEL_ERROR:' + (ConvertTo-Json -InputObject $failure -Compress))
    exit 1
} finally {
    if ($null -ne $panelReader) { $panelReader.Dispose() }
    if ($null -ne $panelWriter) { $panelWriter.Dispose() }
    if ($null -ne $panelErrorWriter) { $panelErrorWriter.Dispose() }
}
