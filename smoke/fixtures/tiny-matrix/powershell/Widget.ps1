. "$PSScriptRoot/Helper.ps1"

function Invoke-Widget {
  param([string]$Name)
  return Format-Label -Name $Name
}
