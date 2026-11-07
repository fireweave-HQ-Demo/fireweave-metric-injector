'use client';

import { Field, Select } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { emptyMetric, formulaDependsOn, type MetricDraft } from '@/lib/metrics';

const types = ['counter', 'gauge', 'histogram'] as const;
const categories = ['success', 'error', 'custom', 'dependent'] as const;

export function MetricEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: MetricDraft[];
  onChange: (next: MetricDraft[]) => void;
  disabled?: boolean;
}) {
  function update(key: string, patch: Partial<MetricDraft>) {
    onChange(value.map((metric) => (metric.key === key ? { ...metric, ...patch } : metric)));
  }

  return (
    <div className="flex flex-col gap-4">
      {value.map((metric, index) => {
        const depends = metric.category === 'dependent' ? formulaDependsOn(metric.formula) : null;
        return (
          <div key={metric.key} className="rounded-md border border-border bg-background p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">
                Metric {index + 1}
                {metric.evalOrder !== undefined ? (
                  <span className="ml-2 font-normal text-muted-foreground">
                    order {metric.evalOrder}
                  </span>
                ) : null}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || value.length === 1}
                onClick={() => onChange(value.filter((item) => item.key !== metric.key))}
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <Input
                  value={metric.name}
                  disabled={disabled}
                  onChange={(event) => update(metric.key, { name: event.target.value })}
                />
              </Field>
              <Field label="Type">
                <Select
                  value={metric.type}
                  disabled={disabled}
                  onChange={(event) =>
                    update(metric.key, { type: event.target.value as MetricDraft['type'] })
                  }
                >
                  {types.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category">
                <Select
                  value={metric.category}
                  disabled={disabled}
                  onChange={(event) =>
                    update(metric.key, { category: event.target.value as MetricDraft['category'] })
                  }
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              className="mt-3"
              label="Tags"
              hint="key=value, separated by commas. Values cannot contain commas."
            >
              <Input
                value={metric.tags}
                disabled={disabled}
                placeholder="service=checkout"
                onChange={(event) => update(metric.key, { tags: event.target.value })}
              />
            </Field>
            {metric.category === 'dependent' ? (
              <div className="mt-3 grid gap-3">
                <Field
                  label="Formula"
                  hint="Numbers, metric names, + - * /, parentheses, random(), normal(mean, sd)."
                >
                  <Textarea
                    value={metric.formula}
                    disabled={disabled}
                    placeholder="errors / (successes + errors)"
                    onChange={(event) => update(metric.key, { formula: event.target.value })}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {depends?.error
                    ? depends.error
                    : `Depends on ${(depends?.names ?? []).join(', ') || 'nothing yet'}`}
                </p>
              </div>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Success probability" hint="Blank uses the job value.">
                  <Input
                    inputMode="decimal"
                    value={metric.successProbability}
                    disabled={disabled}
                    onChange={(event) =>
                      update(metric.key, { successProbability: event.target.value })
                    }
                  />
                </Field>
                <Field label="Error probability" hint="Blank uses the job value.">
                  <Input
                    inputMode="decimal"
                    value={metric.errorProbability}
                    disabled={disabled}
                    onChange={(event) =>
                      update(metric.key, { errorProbability: event.target.value })
                    }
                  />
                </Field>
              </div>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...value, emptyMetric(`metric_${value.length + 1}`)])}
      >
        Add metric
      </Button>
    </div>
  );
}
